package dev.zzanggu.ocgo;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;

import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * 무료 웹 검색 + 페이지 본문 추출.
 * 검색은 DuckDuckGo HTML 엔드포인트(키 불필요)를 쓰고, 실패하면 Wikipedia API로 폴백한다.
 */
@CapacitorPlugin(name = "OcWeb")
public class OcWebPlugin extends Plugin {

    private static final String UA =
            "Mozilla/5.0 (Linux; Android 15; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/140.0.0.0 Mobile Safari/537.36";

    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .followRedirects(true)
            .build();

    @PluginMethod
    public void search(PluginCall call) {
        String query = call.getString("query", "");
        int limit = call.getInt("limit", 6);
        if (query == null || query.trim().isEmpty()) {
            call.reject("검색어가 비어 있습니다");
            return;
        }

        new Thread(() -> {
            try {
                List<JSObject> results = searchDuckDuckGo(query, limit);
                String source = "duckduckgo";
                if (results.isEmpty()) {
                    results = searchWikipedia(query, limit);
                    source = "wikipedia";
                }
                JSObject out = new JSObject();
                JSArray arr = new JSArray();
                for (JSObject r : results) arr.put(r);
                out.put("results", arr);
                out.put("source", source);
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void fetchPage(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !url.startsWith("http")) {
            call.reject("잘못된 URL입니다");
            return;
        }

        new Thread(() -> {
            try {
                Request req = new Request.Builder()
                        .url(url)
                        .header("User-Agent", UA)
                        .header("Accept-Language", "ko-KR,ko;q=0.9,en;q=0.8")
                        .build();
                Response res = client.newCall(req).execute();
                if (!res.isSuccessful() || res.body() == null) {
                    call.reject("HTTP " + res.code());
                    return;
                }
                String html = res.body().string();
                Document doc = Jsoup.parse(html, url);
                doc.select("script,style,noscript,nav,footer,header,aside,form,iframe,svg").remove();

                String title = doc.title();
                String text = doc.body() != null ? doc.body().text() : "";
                text = text.replaceAll("\\s+", " ").trim();
                if (text.length() > 4000) text = text.substring(0, 4000) + "…";

                JSObject out = new JSObject();
                out.put("title", title);
                out.put("url", url);
                out.put("text", text);
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        }).start();
    }

    /* ─────────── DuckDuckGo HTML ─────────── */

    private List<JSObject> searchDuckDuckGo(String query, int limit) throws Exception {
        String url = "https://html.duckduckgo.com/html/?q=" + URLEncoder.encode(query, "UTF-8");
        Request req = new Request.Builder()
                .url(url)
                .header("User-Agent", UA)
                .header("Accept-Language", "ko-KR,ko;q=0.9,en;q=0.8")
                .header("Referer", "https://duckduckgo.com/")
                .build();

        List<JSObject> out = new ArrayList<>();
        Response res = client.newCall(req).execute();
        if (!res.isSuccessful() || res.body() == null) return out;

        Document doc = Jsoup.parse(res.body().string());
        Elements items = doc.select("div.result");
        for (Element item : items) {
            if (item.hasClass("result--ad")) continue;
            Element a = item.selectFirst("a.result__a");
            if (a == null) continue;

            String href = a.attr("href");
            String real = unwrapDuckDuckGo(href);
            if (real == null || real.isEmpty()) continue;

            Element sn = item.selectFirst(".result__snippet");
            String snippet = sn != null ? sn.text() : "";

            JSObject r = new JSObject();
            r.put("title", a.text());
            r.put("url", real);
            r.put("snippet", snippet.length() > 300 ? snippet.substring(0, 300) : snippet);
            out.add(r);
            if (out.size() >= limit) break;
        }
        return out;
    }

    /** DDG 결과 링크는 //duckduckgo.com/l/?uddg=<인코딩된 실제 URL> 형태다. */
    private static String unwrapDuckDuckGo(String href) {
        try {
            if (href == null) return null;
            if (href.startsWith("//")) href = "https:" + href;
            int i = href.indexOf("uddg=");
            if (i < 0) return href;
            String enc = href.substring(i + 5);
            int amp = enc.indexOf('&');
            if (amp >= 0) enc = enc.substring(0, amp);
            return java.net.URLDecoder.decode(enc, "UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    /* ─────────── Wikipedia 폴백 ─────────── */

    private List<JSObject> searchWikipedia(String query, int limit) throws Exception {
        String url = "https://ko.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit="
                + limit + "&srsearch=" + URLEncoder.encode(query, "UTF-8");
        Request req = new Request.Builder().url(url).header("User-Agent", UA).build();
        List<JSObject> out = new ArrayList<>();

        Response res = client.newCall(req).execute();
        if (!res.isSuccessful() || res.body() == null) return out;

        JSONObject json = new JSONObject(res.body().string());
        JSONArray hits = json.optJSONObject("query") != null
                ? json.getJSONObject("query").optJSONArray("search") : null;
        if (hits == null) return out;

        for (int i = 0; i < hits.length(); i++) {
            JSONObject h = hits.getJSONObject(i);
            String title = h.optString("title", "");
            JSObject r = new JSObject();
            r.put("title", title);
            r.put("url", "https://ko.wikipedia.org/wiki/" + URLEncoder.encode(title.replace(' ', '_'), "UTF-8"));
            r.put("snippet", Jsoup.parse(h.optString("snippet", "")).text());
            out.add(r);
        }
        return out;
    }
}
