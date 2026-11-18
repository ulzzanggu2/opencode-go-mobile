package dev.zzanggu.ocgo;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.Locale;

/**
 * 음성 입력(SpeechRecognizer) + 음성 출력(TextToSpeech) 브리지.
 * 한국어(ko-KR) 기본.
 */
@CapacitorPlugin(
        name = "OcSpeech",
        permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class OcSpeechPlugin extends Plugin {

    private SpeechRecognizer recognizer;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private String pendingUtteranceId = null;

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (ttsReady) {
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String utteranceId) {}

                    @Override public void onDone(String utteranceId) {
                        if (utteranceId.equals(pendingUtteranceId)) {
                            pendingUtteranceId = null;
                            JSObject out = new JSObject();
                            out.put("done", true);
                            notifyListeners("speakDone", out);
                        }
                    }

                    @Override public void onError(String utteranceId) {
                        pendingUtteranceId = null;
                        notifyListeners("speakDone", new JSObject());
                    }
                });
            }
        });
    }

    @PluginMethod
    public void available(PluginCall call) {
        JSObject out = new JSObject();
        out.put("stt", SpeechRecognizer.isRecognitionAvailable(getContext()));
        out.put("tts", ttsReady);
        boolean ko = false;
        if (ttsReady) {
            int r = tts.isLanguageAvailable(new Locale("ko", "KR"));
            ko = r >= TextToSpeech.LANG_AVAILABLE;
        }
        out.put("ttsKo", ko);
        call.resolve(out);
    }

    /* ─────────── 음성 인식 ─────────── */

    @PluginMethod
    public void startListening(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micPermCallback");
            return;
        }
        beginListening(call.getString("lang", "ko-KR"));
        call.resolve();
    }

    @PermissionCallback
    private void micPermCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            beginListening(call.getString("lang", "ko-KR"));
            call.resolve();
        } else {
            call.reject("마이크 권한이 거부되었습니다");
        }
    }

    private void beginListening(String lang) {
        getActivity().runOnUiThread(() -> {
            try {
                stopRecognizer();
                if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                    notifySttError("이 기기에서 음성 인식을 사용할 수 없습니다");
                    return;
                }
                recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                recognizer.setRecognitionListener(new RecognitionListener() {
                    @Override public void onReadyForSpeech(Bundle params) {}
                    @Override public void onBeginningOfSpeech() {}
                    @Override public void onRmsChanged(float rmsdB) {}
                    @Override public void onBufferReceived(byte[] buffer) {}
                    @Override public void onEndOfSpeech() {}

                    @Override public void onError(int error) {
                        if (error != SpeechRecognizer.ERROR_NO_MATCH
                                && error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                                && error != SpeechRecognizer.ERROR_CLIENT) {
                            notifySttError(describeError(error));
                        }
                        stopRecognizer();
                    }

                    @Override public void onResults(Bundle results) {
                        ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        JSObject out = new JSObject();
                        out.put("text", list != null && !list.isEmpty() ? list.get(0) : "");
                        notifyListeners("final", out);
                        stopRecognizer();
                    }

                    @Override public void onPartialResults(Bundle partial) {
                        ArrayList<String> list = partial.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        if (list != null && !list.isEmpty()) {
                            JSObject out = new JSObject();
                            out.put("text", list.get(0));
                            notifyListeners("partial", out);
                        }
                    }

                    @Override public void onEvent(int eventType, Bundle params) {}
                });

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
                intent.putExtra(RecognizerIntent.EXTRA_ONLY_RETURN_LANGUAGE_PREFERENCE, false);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                recognizer.startListening(intent);
            } catch (Exception e) {
                notifySttError(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        stopRecognizer();
        call.resolve();
    }

    private void stopRecognizer() {
        try {
            if (recognizer != null) {
                recognizer.stopListening();
                recognizer.cancel();
                recognizer.destroy();
                recognizer = null;
            }
        } catch (Exception ignored) {}
    }

    private void notifySttError(String message) {
        JSObject out = new JSObject();
        out.put("message", message);
        notifyListeners("sttError", out);
    }

    private static String describeError(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_AUDIO: return "오디오 오류";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "마이크 권한 없음";
            case SpeechRecognizer.ERROR_NETWORK: return "네트워크 오류";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "네트워크 시간 초과";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "인식기가 사용 중입니다";
            case SpeechRecognizer.ERROR_SERVER: return "인식 서버 오류";
            case SpeechRecognizer.ERROR_NO_MATCH: return "알아듣지 못했습니다";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "말소리가 없습니다";
            default: return "음성 인식 오류 (" + code + ")";
        }
    }

    /* ─────────── 음성 출력 ─────────── */

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        String lang = call.getString("lang", "ko-KR");
        double rate = call.getDouble("rate", 1.0);
        if (text == null || text.trim().isEmpty()) { call.resolve(); return; }
        if (!ttsReady) { call.reject("TTS를 사용할 수 없습니다"); return; }

        try {
            tts.setLanguage(Locale.forLanguageTag(lang));
            tts.setSpeechRate((float) rate);
            String id = "ocgo-" + System.currentTimeMillis();
            pendingUtteranceId = id;
            tts.stop();
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
        }
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        try {
            if (tts != null) tts.stop();
        } catch (Exception ignored) {}
        pendingUtteranceId = null;
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopRecognizer();
        try {
            if (tts != null) { tts.stop(); tts.shutdown(); }
        } catch (Exception ignored) {}
        super.handleOnDestroy();
    }
}
