# Desk #59: R8 for the watch app (release). AAPT already keeps manifest components; these rules say it explicitly, so a
# rename or a removed manifest entry cannot silently drop a class the system binds by name.

# Bound by name from the manifest / the system
-keep class com.bryan.revolutx.wear.MainActivity { *; }
-keep class com.bryan.revolutx.wear.OpenOnPhoneActivity { *; }
-keep class com.bryan.revolutx.wear.KeyListener { *; }          # Data Layer WearableListenerService (the key handover)
-keep class com.bryan.revolutx.wear.RxTileService { *; }        # Tiles: Portfolio, Coin 1-3, Top movers, PM notes
-keep class com.bryan.revolutx.wear.BaseTile { *; }
-keep class com.bryan.revolutx.wear.CoinTileService { *; }
-keep class com.bryan.revolutx.wear.CoinTile1 { *; }
-keep class com.bryan.revolutx.wear.CoinTile2 { *; }
-keep class com.bryan.revolutx.wear.CoinTile3 { *; }
-keep class com.bryan.revolutx.wear.MoversTileService { *; }
-keep class com.bryan.revolutx.wear.NotesTileService { *; }
-keep class com.bryan.revolutx.wear.CoinActivity { *; }         # started from Tiles by class name
-keep class com.bryan.revolutx.wear.TileCoinsActivity { *; }
-keep class com.bryan.revolutx.wear.ComplicationBase { *; }
-keep class com.bryan.revolutx.wear.TotalComplication { *; }    # the four complication data sources
-keep class com.bryan.revolutx.wear.PnlComplication { *; }
-keep class com.bryan.revolutx.wear.NotesComplication { *; }
-keep class com.bryan.revolutx.wear.MoverComplication { *; }
-keep class com.bryan.revolutx.wear.CardComplication { *; }     # the Revolut X face's card, dot and always-on total
-keep class com.bryan.revolutx.wear.DotComplication { *; }
-keep class com.bryan.revolutx.wear.FaceTotalComplication { *; }
# The Tile's LaunchAction names OpenOnPhoneActivity by its class name at run time (getName()): kept above.

# EncryptedSharedPreferences (androidx.security-crypto) and Tink: Tink's keysets are protobuf-lite messages read by
# reflection on their fields, so those fields must keep their names.
-keep class androidx.security.crypto.** { *; }
-keepclassmembers class * extends com.google.crypto.tink.shaded.protobuf.GeneratedMessageLite { <fields>; }
-keep class com.google.crypto.tink.proto.** { *; }

# Compile-time-only annotations and optional dependencies Tink refers to but never loads on Android
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
-dontwarn com.google.api.client.**
-dontwarn org.joda.time.**
