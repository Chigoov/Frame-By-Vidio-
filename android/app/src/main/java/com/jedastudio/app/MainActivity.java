package com.jedastudio.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GallerySaverPlugin.class);
        registerPlugin(SecureSessionPlugin.class);
        registerPlugin(JedaBillingPlugin.class);
        registerPlugin(VdsrUpscalerPlugin.class);
        registerPlugin(VideoFramesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
