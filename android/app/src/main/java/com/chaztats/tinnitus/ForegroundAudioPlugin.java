package com.chaztats.tinnitus;

import android.content.Intent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ForegroundAudio")
public class ForegroundAudioPlugin extends Plugin {

    @PluginMethod
    public void startPlayback(PluginCall call) {
        String assetPath = call.getString(ForegroundAudioService.EXTRA_ASSET_PATH);
        if (assetPath == null || assetPath.isEmpty()) {
            call.reject("assetPath is required");
            return;
        }

        Double volumeValue = call.getDouble(ForegroundAudioService.EXTRA_VOLUME, 1.0);
        Double panValue = call.getDouble(ForegroundAudioService.EXTRA_PAN, 0.0);
        float volume = volumeValue != null ? volumeValue.floatValue() : 1f;
        float pan = panValue != null ? panValue.floatValue() : 0f;

        Intent serviceIntent = new Intent(getContext(), ForegroundAudioService.class);
        serviceIntent.setAction(ForegroundAudioService.ACTION_START_PLAYBACK);
        serviceIntent.putExtra(ForegroundAudioService.EXTRA_ASSET_PATH, assetPath);
        serviceIntent.putExtra(ForegroundAudioService.EXTRA_VOLUME, volume);
        serviceIntent.putExtra(ForegroundAudioService.EXTRA_PAN, pan);

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            getContext().startForegroundService(serviceIntent);
        } else {
            getContext().startService(serviceIntent);
        }

        call.resolve();
    }

    @PluginMethod
    public void updateLevels(PluginCall call) {
        Double volumeValue = call.getDouble(ForegroundAudioService.EXTRA_VOLUME, 1.0);
        Double panValue = call.getDouble(ForegroundAudioService.EXTRA_PAN, 0.0);
        float volume = volumeValue != null ? volumeValue.floatValue() : 1f;
        float pan = panValue != null ? panValue.floatValue() : 0f;

        Intent serviceIntent = new Intent(getContext(), ForegroundAudioService.class);
        serviceIntent.setAction(ForegroundAudioService.ACTION_UPDATE_LEVELS);
        serviceIntent.putExtra(ForegroundAudioService.EXTRA_VOLUME, volume);
        serviceIntent.putExtra(ForegroundAudioService.EXTRA_PAN, pan);
        getContext().startService(serviceIntent);

        call.resolve();
    }

    @PluginMethod
    public void stopPlayback(PluginCall call) {
        Intent serviceIntent = new Intent(getContext(), ForegroundAudioService.class);
        serviceIntent.setAction(ForegroundAudioService.ACTION_STOP);
        getContext().startService(serviceIntent);

        call.resolve();
    }
}
