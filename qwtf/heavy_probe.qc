// qwtf/heavy_probe.qc -- TEST-ONLY probe: opens the Heavy class gate and
// answers one live question ("what is this player's maxspeed right now?").
//
// NOT IN THE SHIPPED BUILD. Nothing includes it. It is compiled only when
// scripts/build_progs.sh is given QWTF_EXTRA_QC=heavy_probe.qc, which only
// tests/test_heavy.js does, and then into QWTF_PROGS_OUT so the shipped
// progs.dat/qwprogs.dat in web/id1 are never touched (tests/test_stringeq.js
// is the precedent for both halves: the extra-file hook is build_progs.sh's
// own, and the output goes to a test directory).
//
// THE GATE. The Heavy's gate is QWTF_class_available (qwtf/classes.qc:116), a
// file this lane must not edit, and tests/ctf_rules.js asserts the class is
// refused until its lane has shipped -- also a file this lane must not edit.
// So the SHIPPED game keeps refusing the class, and the TEST's progs open it,
// exactly as qwtf/sniper_probe.qc does for the Sniper. Everything behind the
// gate is the shipped code: the class stats and slots come from classes.qc's
// own table (the "M5b SLOTS" comment), the spawn applies through classes.qc's
// QWTF_class_apply wrap, the command comes from the page's real menu click ->
// qwtf_setclass heavy, and the GUN is qwtf/heavy.qc's wraps. The probe flips
// one boolean's answer and nothing else.
//
// THE SPEED QUESTION. The brief's done-when wants the Heavy's SPEED while
// firing (112) and after release (224), with qwtf_trace OFF -- and
// QWTF_EVENT class_stats prints speed only at the class apply, never live.
// So the probe adds one test-only client command, `hv_speed`: it prints the
// server's own copy of the caller's maxspeed as an event line and changes
// nothing. The command dispatch is classes.qc's SV_ParseClientCommand, whose
// last act for an unknown command is clientcommand() -- a probe command must
// be intercepted BEFORE that, or the engine echoes "Unknown command".
// The comparison is argv(0) against a literal, the exact form qwtf/stringeq_probe.qc
// measured (and classes.qc itself uses): `==` is correct here.
//
// THE NEGATIVE CONTROL IT ENABLES: the same probe build WITHOUT heavy.qc
// (QWTF_QC_SKIP=heavy.qc) still spawns a "heavy" -- classes.qc's table gives
// the class its stats and slots -- but the gun is the stock super nailgun:
// no QWTF_EVENT heavy_spin or heavy_shot ever prints, so the new test fails
// first on the old code rather than on its own setup.

#ifdef __QW__

wrap float(float id) QWTF_class_available =
{
    if (id == QWTF_CLASS_HEAVY)
        return 1;
    return prior(id);
};

wrap void(string cmd) SV_ParseClientCommand =
{
    tokenize(cmd);
    if (argv(0) == "hv_speed")
    {
        dprint("QWTF_EVENT heavy_speed ");
        dprint(self.netname);
        dprint(" maxspeed=");
        dprint(ftos(self.maxspeed));
        dprint("\n");
        return;
    }
    prior(cmd);
};

#endif
