// qwtf/stringeq_probe.qc -- TEST-ONLY probe: what does `string == string`
// actually DO in this progs? (reviewer 0506 item 1)
//
// NOT IN THE SHIPPED BUILD. Nothing includes it. It is compiled only when
// scripts/build_progs.sh is given QWTF_EXTRA_QC=stringeq_probe.qc, which only
// tests/test_stringeq.js does, and it prints nothing unless a test runs a server
// with `developer 1`.
//
// WHY: the lobby commands failed 5 of ctf_rules.js's lobby checks with a
// pattern that fits exactly one cause -- every `qwtf_*` command took the FIRST
// branch in SV_ParseClientCommand (so "qwtf_setclass scout" ran
// QWTF_cmd_setteam) and every side took the first one there too (so "blue"
// placed the player on red). That is what a string `==` that is TRUE when the
// strings DIFFER would look like from the outside, and 0506 named it as the
// root cause. Measured (tests/test_stringeq.js, 14 lines in one server boot):
// it is not that. `==` is correct for every runtime form the lobby uses. What
// was broken is the wire form in web/menu.js -- see the comment there.
//
// THE MEASUREMENT MUST NOT USE THE OPERATOR IT MEASURES. There is no
// `dprint(ftos(a == "x"))` in here: a result printed by an expression
// containing the suspect operator would be circular. Every line below is an
// `if (suspect)` with two dprint arms, so what the log says is literally
// "which branch did the engine take".
//
// A label says what the expression IS; read_true / read_false says what
// HAPPENED. Everything is printed from the world's own worldspawn, once per map
// load, after the map is up.

#ifdef __QW__

// .string on world: the "does copying through a field change the answer" test,
// and the probe's own scratch space.
.string probe_a;

void() QWTF_streq_probe =
{
    local string a, b, c, d;

    // a/c are command names and b/d their first argument -- exactly the two
    // shapes qwtf/classes.qc compares, in SV_ParseClientCommand and in
    // QWTF_cmd_setteam.
    tokenize("qwtf_setteam red");
    a = argv(0);
    b = argv(1);
    tokenize("qwtf_setclass scout");
    c = argv(0);
    d = argv(1);

    // -- 1. a runtime string against a literal: same and different -----------
    dprint("STREQ argv0_same ");
    if (a == "qwtf_setteam") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ argv0_diff ");
    if (a == "qwtf_setclass") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ argv0_diff_short ");
    if (a == "red") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ argv1_same ");
    if (b == "red") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ argv1_diff ");
    if (b == "blue") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ argv0_setclass_same ");
    if (c == "qwtf_setclass") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ argv0_setclass_diff ");
    if (c == "qwtf_setteam") dprint("read_true\n"); else dprint("read_false\n");

    // -- 2. two runtime strings: equal and different -------------------------
    dprint("STREQ runtime_pair_diff ");
    if (a == c) dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ runtime_pair_diff_args ");
    if (b == d) dprint("read_true\n"); else dprint("read_false\n");
    tokenize("red");
    d = argv(0);
    dprint("STREQ runtime_pair_same ");
    if (b == d) dprint("read_true\n"); else dprint("read_false\n");

    // -- 3. against the empty string, and the `!=` direction ---------------
    // qwtf/probe.qc gates three things on `infokey(...) != ""` and
    // qwtf/classes.qc gates two on `classname != "player"`, so the negated form
    // is measured here too rather than assumed to be the same opcode.
    dprint("STREQ argv0_vs_empty ");
    if (a == "") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ argv0_ne_same ");
    if (a != "qwtf_setteam") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ argv0_ne_diff ");
    if (a != "qwtf_setclass") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ ctrl_infokey_ne_empty ");
    if (infokey(world, "qwtf_trace") != "") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ ctrl_classname_ne_player ");
    if (self.classname != "player") dprint("read_true\n"); else dprint("read_false\n");

    // -- 4. copied through a .string field first -----------------------------
    world.probe_a = a;
    dprint("STREQ field_argv0_same ");
    if (world.probe_a == "qwtf_setteam") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ field_argv0_diff ");
    if (world.probe_a == "qwtf_setclass") dprint("read_true\n"); else dprint("read_false\n");
    world.probe_a = "literal value";
    dprint("STREQ field_literal_same ");
    if (world.probe_a == "literal value") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ field_literal_diff ");
    if (world.probe_a == "not the same") dprint("read_true\n"); else dprint("read_false\n");

    // -- 5. THE CLAIM, IN THE REVIEWER'S OWN TERMS ---------------------------
    // What SV_ParseClientCommand decides for each of the two commands the
    // overlay sends, using the same comparisons the shipped code uses. `a` holds
    // "qwtf_setteam", `b` holds "red", `c` holds "qwtf_setclass" and `d` holds
    // "scout" -- and the last two lines redo the pair with "blue" in the
    // argument slot, because that is the second branch the 0506 report called
    // broken.
    local string blue_arg;
    tokenize("qwtf_setteam blue");
    blue_arg = argv(1);

    dprint("STREQ dispatch_argv0_is_setteam ");
    if (a == "qwtf_setteam") dprint("-> QWTF_cmd_setteam\n"); else dprint("-> QWTF_cmd_setclass\n");
    dprint("STREQ dispatch_argv0_is_setclass ");
    if (c == "qwtf_setteam") dprint("-> QWTF_cmd_setteam\n"); else dprint("-> QWTF_cmd_setclass\n");
    dprint("STREQ dispatch_argv1_is_red ");
    if (b == "red") dprint("-> red\n"); else dprint("-> not red\n");
    dprint("STREQ dispatch_argv1_is_blue ");
    if (blue_arg == "red") dprint("-> red\n"); else dprint("-> not red\n");

    // -- 6. CONTROLS: two forms the rest of the tree already depends on -------
    // classname is what bots.qc and eggs.qc gate on (`classname == "player"`),
    // and infokey is what probe.qc gates the whole trace on. If either control
    // were broken the tree would have a second, different problem and the `==`
    // story would only be half of it.
    dprint("STREQ ctrl_classname_value ");
    dprint(self.classname);
    dprint("\n");
    dprint("STREQ ctrl_classname_is_world ");
    if (self.classname == "world") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ ctrl_classname_is_worldspawn ");
    if (self.classname == "worldspawn") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ ctrl_classname_is_player ");
    if (self.classname == "player") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ ctrl_infokey_same ");
    if (infokey(world, "qwtf_trace") == "1") dprint("read_true\n"); else dprint("read_false\n");
    dprint("STREQ ctrl_infokey_diff ");
    if (infokey(world, "qwtf_trace") == "0") dprint("read_true\n"); else dprint("read_false\n");
};

wrap void() worldspawn =
{
    prior();
    QWTF_streq_probe();
};

#else

void() QWTF_streq_probe_unavailable =
{
    dprint("QWTF_STRINGEQ_PROBE unavailable: this progs is not the QW build\n");
};

wrap void() worldspawn =
{
    prior();
    QWTF_streq_probe_unavailable();
};

#endif