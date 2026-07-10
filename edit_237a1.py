import sys, hashlib

PATH = "server.js"

with open(PATH, "r", encoding="utf-8", newline="") as f:
    src = f.read()

anchor1 = """      await setTrailingStop(symbol, parseFloat(rule.trail_pct), currentPrice, entryFloor);
      await db.execute('UPDATE pump_armed_rules SET armed = 1 WHERE symbol = ?', [symbol]);"""

replacement1 = """      // #237 ask-1: gate autonomous Stage-2 auto-sell on the per-coin loop_enabled
      // flag (double-gate: global ai_auto_execute master + this per-coin switch, per
      // the double-gated-autonomy design principle). loop_enabled=1 -> arm an
      // auto-executing trailing stop (breach sells without a Telegram reply, floor
      // guards in autoExecuteSell still apply); loop_enabled=0 -> notify-only, exactly
      // as before. Previously this non-DND path never passed autoExecute, so EVERY
      // non-DND pump-armed coin was silently notify-only and never auto-sold (the
      // IDEX overnight non-execution). The DND branch above already passed true.
      const loopEnabledArm = parseInt(rule.loop_enabled) === 1;
      await setTrailingStop(symbol, parseFloat(rule.trail_pct), currentPrice, entryFloor, loopEnabledArm, loopEnabledArm ? (rule.sell_pct || 50) : null);
      await db.execute('UPDATE pump_armed_rules SET armed = 1 WHERE symbol = ?', [symbol]);"""

anchor2 = "        `\\n\u26a0\ufe0f Stage 1 \u2014 monitoring only, no auto-sell yet. You'll be alerted if the trail breaches.`\n      ).catch(() => {});"

replacement2 = "        (loopEnabledArm\n          ? `\\n\u2705 Stage 2 ACTIVE \u2014 will AUTO-SELL ${rule.sell_pct || 50}% on trail breach (no reply needed). Floor guard still applies.`\n          : `\\n\u26a0\ufe0f Stage 1 \u2014 monitoring only, no auto-sell yet. You'll be alerted if the trail breaches.`)\n      ).catch(() => {});"

for name, anchor in [("anchor1", anchor1), ("anchor2", anchor2)]:
    c = src.count(anchor)
    if c != 1:
        print(f"ABORT: {name} found {c} times (expected 1). No changes written.")
        sys.exit(1)

src2 = src.replace(anchor1, replacement1, 1)
src2 = src2.replace(anchor2, replacement2, 1)

if not src2.endswith("\n"):
    src2 += "\n"

with open(PATH, "w", encoding="utf-8", newline="") as f:
    f.write(src2)

with open(PATH, "rb") as f:
    final_bytes = f.read()

print("WROTE OK")
print("new_sha256:", hashlib.sha256(final_bytes).hexdigest())
print("new_size:", len(final_bytes))
print("added_lines:", src2.count(chr(10)) - src.count(chr(10)))
