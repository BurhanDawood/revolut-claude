package com.bryan.revolutx;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The fingerprint lock the shell calls as
 * Capacitor.Plugins.BiometricAuth.authenticate({ reason, cancelTitle, allowDeviceCredential, androidTitle, androidSubtitle }).
 * Resolves on success, rejects on cancel or failure.
 *
 * A phone with no fingerprint and no screen lock at all cannot be asked for either: the call then resolves
 * with { skipped: true }, so the shell never locks Bryan out of his own app.
 */
@CapacitorPlugin(name = "BiometricAuth")
public class BiometricAuthPlugin extends Plugin {

    @PluginMethod
    public void authenticate(final PluginCall call) {
        final boolean allowCredential = Boolean.TRUE.equals(call.getBoolean("allowDeviceCredential", true));
        final int authenticators = allowCredential
            ? BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL
            : BiometricManager.Authenticators.BIOMETRIC_WEAK;

        int can = BiometricManager.from(getContext()).canAuthenticate(authenticators);
        if (
            can == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ||
            can == BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE ||
            can == BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED
        ) {
            JSObject r = new JSObject();
            r.put("skipped", true);
            call.resolve(r);
            return;
        }

        getActivity().runOnUiThread(() -> {
            BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(call.getString("androidTitle", "Revolut X"))
                .setSubtitle(call.getString("androidSubtitle", null))
                .setDescription(call.getString("reason", null))
                .setAllowedAuthenticators(authenticators);
            if (!allowCredential) info.setNegativeButtonText(call.getString("cancelTitle", "Cancel"));

            BiometricPrompt prompt = new BiometricPrompt(
                getActivity(),
                ContextCompat.getMainExecutor(getContext()),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        call.resolve();
                    }

                    @Override
                    public void onAuthenticationError(int code, CharSequence msg) {
                        call.reject(String.valueOf(msg), String.valueOf(code));
                    }
                    // onAuthenticationFailed (one bad finger) leaves the prompt open for another try
                }
            );
            try {
                prompt.authenticate(info.build());
            } catch (Exception e) {
                call.reject("could not show the prompt");
            }
        });
    }
}
