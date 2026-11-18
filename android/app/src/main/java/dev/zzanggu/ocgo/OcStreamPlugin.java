package dev.zzanggu.ocgo;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * OpenCode Go 스트리밍 브리지.
 * WebView의 CORS 제약을 피하려고 네이티브 OkHttp로 SSE를 읽고 JS로 델타를 흘려보낸다.
 */
@CapacitorPlugin(name = "OcStream")
public class OcStreamPlugin extends Plugin {

    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)      // 스트리밍: 읽기 타임아웃 없음
            .writeTimeout(30, TimeUnit.SECONDS)
            .build();

    private Call currentCall;
    private Thread worker;

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url");
        String body = call.getString("body");
        JSObject headers = call.getObject("headers", new JSObject());
        if (url == null || body == null) {
            call.reject("url과 body가 필요합니다");
            return;
        }

        Request.Builder rb = new Request.Builder()
                .url(url)
                .post(RequestBody.create(body, JSON));

        if (headers != null) {
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                String v = headers.getString(k);
                if (v != null) rb.header(k, v);
            }
        }

        final Request request = rb.build();
        cancelCurrent();

        worker = new Thread(() -> {
            final Call myCall = client.newCall(request);
            synchronized (OcStreamPlugin.this) {
                currentCall = myCall;
            }
            try {
                Response response = myCall.execute();
                if (!response.isSuccessful()) {
                    ResponseBody eb = response.body();
                    String detail = eb != null ? eb.string() : "";
                    notifyError("HTTP " + response.code() + (detail.isEmpty() ? "" : ": " + trim(detail)));
                    return;
                }
                ResponseBody rb2 = response.body();
                if (rb2 == null) { notifyError("응답 본문이 없습니다"); return; }

                BufferedReader reader = new BufferedReader(new InputStreamReader(rb2.byteStream(), "UTF-8"));
                String line;
                StringBuilder acc = new StringBuilder();
                java.util.LinkedHashMap<Integer, JSONObject> toolAcc = new java.util.LinkedHashMap<>();
                String finishReason = null;
                while ((line = reader.readLine()) != null) {
                    String s = line.trim();
                    if (s.isEmpty() || !s.startsWith("data:")) continue;
                    String payload = s.substring(5).trim();
                    if (payload.equals("[DONE]")) break;
                    try {
                        JSONObject json = new JSONObject(payload);
                        JSONArray choices = json.optJSONArray("choices");
                        if (choices == null || choices.length() == 0) continue;
                        JSONObject choice = choices.optJSONObject(0);
                        if (choice == null) continue;

                        String fr = choice.optString("finish_reason", "");
                        if (!fr.isEmpty() && !fr.equals("null")) finishReason = fr;

                        JSONObject delta = choice.optJSONObject("delta");
                        if (delta == null) continue;

                        if (delta.has("content") && !delta.isNull("content")) {
                            String t = delta.optString("content", "");
                            if (!t.isEmpty()) {
                                acc.append(t);
                                JSObject out = new JSObject();
                                out.put("text", t);
                                notifyListeners("delta", out);
                            }
                        }

                        // 도구 호출은 조각조각 흘러오므로 index 기준으로 누적한다
                        JSONArray tcs = delta.optJSONArray("tool_calls");
                        if (tcs != null) {
                            for (int i = 0; i < tcs.length(); i++) {
                                JSONObject c = tcs.optJSONObject(i);
                                if (c == null) continue;
                                int idx = c.optInt("index", i);
                                JSONObject cur = toolAcc.get(idx);
                                if (cur == null) {
                                    cur = new JSONObject();
                                    cur.put("index", idx);
                                    toolAcc.put(idx, cur);
                                }
                                if (c.has("id")) cur.put("id", c.optString("id"));
                                if (c.has("type")) cur.put("type", c.optString("type"));
                                JSONObject fn = c.optJSONObject("function");
                                if (fn != null) {
                                    JSONObject curFn = cur.optJSONObject("function");
                                    if (curFn == null) curFn = new JSONObject();
                                    if (fn.has("name")) curFn.put("name", fn.optString("name"));
                                    if (fn.has("arguments")) {
                                        curFn.put("arguments", curFn.optString("arguments", "") + fn.optString("arguments", ""));
                                    }
                                    cur.put("function", curFn);
                                }
                            }
                        }
                    } catch (Exception ignore) {
                        // 조각이 잘린 경우 등은 건너뛴다
                    }
                }
                reader.close();

                if (!toolAcc.isEmpty()) {
                    JSONArray calls = new JSONArray();
                    for (JSONObject c : toolAcc.values()) calls.put(c);
                    JSObject out = new JSObject();
                    out.put("calls", calls);
                    out.put("text", acc.toString());
                    out.put("finishReason", finishReason == null ? "" : finishReason);
                    notifyListeners("toolcalls", out);
                } else {
                    JSObject done = new JSObject();
                    done.put("text", acc.toString());
                    done.put("finishReason", finishReason == null ? "" : finishReason);
                    notifyListeners("done", done);
                }
            } catch (Exception e) {
                // 이 스레드의 호출만 확인한다 (다음 라운드가 currentCall을 교체해도 영향 없음)
                if (!myCall.isCanceled()) {
                    notifyError(e.getMessage() == null ? e.toString() : e.getMessage());
                }
            } finally {
                synchronized (OcStreamPlugin.this) {
                    if (currentCall == myCall) currentCall = null;
                }
            }
        });
        worker.start();
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancelCurrent();
        call.resolve();
    }

    private void cancelCurrent() {
        Call c;
        synchronized (this) {
            c = currentCall;
            currentCall = null;
        }
        try {
            if (c != null) c.cancel();
        } catch (Exception ignored) {}
    }

    private void notifyError(String message) {
        JSObject err = new JSObject();
        err.put("message", message);
        notifyListeners("error", err);
    }

    private static String trim(String s) {
        return s.length() > 300 ? s.substring(0, 300) + "…" : s;
    }

    /** OpenAI 호환 청크에서 본문 텍스트만 뽑아낸다. */
    private static String extractDelta(String payload) {
        try {
            JSONObject json = new JSONObject(payload);
            JSONArray choices = json.optJSONArray("choices");
            if (choices == null || choices.length() == 0) return null;
            JSONObject choice = choices.optJSONObject(0);
            if (choice == null) return null;
            JSONObject delta = choice.optJSONObject("delta");
            if (delta != null && delta.has("content") && !delta.isNull("content")) {
                return delta.optString("content", "");
            }
            // 일부 게이트웨이는 누적 message 형태로 보낸다
            JSONObject message = choice.optJSONObject("message");
            if (message != null && message.has("content")) {
                return message.optString("content", "");
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        cancelCurrent();
        super.handleOnDestroy();
    }
}
