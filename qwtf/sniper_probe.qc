// qwtf/sniper_probe.qc -- TEST-ONLY probe: opens the Sniper class gate.
//
// NOT IN THE SHIPPED BUILD. Nothing includes it. It is compiled only when
// scripts/build_progs.sh is given QWTF_EXTRA_QC=sniper_probe.qc, which only
// tests/test_sniper.js does, and then into QWTF_PROGS_OUT so the shipped
// progs.dat/qwprogs.dat in web/id1 are never touched (tests/test_stringeq.js
// is the precedent for both halves: the extra-file hook is build_progs.sh's
// own, and the output goes to a test directory).
//
// WHY THIS HAS TO EXIST. The sniper gate is QWTF_class_available
// (qwtf/classes.qc:116), a file this lane must not edit, and
// tests/ctf_rules.js's lobby check asserts "sniper is refused while M5b has
// not shipped it" -- also a file this lane must not edit. So the SHIPPED game
// keeps refusing the class, and the TEST's progs open it, exactly as
// tests/test_stringeq.js builds a progs that can measure what the shipped one
// computes. Everything behind the gate is the shipped code: the class stats
// and slots come from classes.qc's own table (the "M5b SLOTS" comment), the
// spawn applies through classes.qc's PutClientInServer wrap, the command comes
// from the page's real menu click -> qwtf_setclass sniper -> the first pick
// applies at once, and the GUNS are qwtf/sniper.qc's wraps. The probe changes
// one boolean's answer and nothing else.
//
// THE NEGATIVE CONTROL IT ENABLES: the same probe build WITHOUT sniper.qc
// (QWTF_QC_SKIP=sniper.qc) still spawns a "sniper" -- classes.qc's table gives
// the class its stats and slots -- but the guns are the stock super shotgun
// and nailgun and no QWTF_EVENT sniper_* line ever prints, so the new test
// fails first on the old code rather than on its own setup.

#ifdef __QW__

wrap float(float id) QWTF_class_available =
{
    if (id == QWTF_CLASS_SNIPER)
        return 1;
    return prior(id);
};

#endif