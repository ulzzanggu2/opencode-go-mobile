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
            try {
                currentCall = client.newCall(request);
                Response response = currentCall.execute();
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
                while ((line = reader.readLine()) != null) {
                    String s = line.trim();
                    if (s.isEmpty() || !s.startsWith("data:")) continue;
                    String payload = s.substring(5).trim();
                    if (payload.equals("[DONE]")) break;
                    String delta = extractDelta(payload);
                    if (delta != null && !delta.isEmpty()) {
                        acc.append(delta);
                        JSObject out = new JSObject();
                        out.put("text", delta);
                        notifyListeners("delta", out);
                    }
                }
                reader.close();

                JSObject done = new JSObject();
                done.put("text", acc.toString());
                notifyListeners("done", done);
            } catch (Exception e) {
                if (currentCall == null || !currentCall.isCanceled()) {
                    notifyError(e.getMessage() == null ? e.toString() : e.getMessage());
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
        try {
            if (currentCall != null) currentCall.cancel();
        } catch (Exception ignored) {}
        currentCall = null;
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
