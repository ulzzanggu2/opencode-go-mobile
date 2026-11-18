package dev.zzanggu.ocgo;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 플러그인은 super.onCreate 이전에 등록해야 브리지에 연결된다.
        registerPlugin(OcStreamPlugin.class);
        registerPlugin(OcSpeechPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
