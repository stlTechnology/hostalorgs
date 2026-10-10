// qwtf/botnav_probe.qc -- TEST-ONLY (QWTF_EXTRA_QC). Every 0.5 s: Bot Red's
// position, its route id and the node it is heading for, and its stuck count.
#ifdef __QW__
void() QWTF_bnp_think =
{
    local entity b;
    self.nextthink = time + 0.5;
    b = find(world, netname, "Bot Red");
    if (cvar("qwtf_probe_blue")) b = find(world, netname, "Bot Blue");
    if (!b) return;
    dprint("QWTF_NAV t="); dprint(ftos(time)); dprint(" at="); dprint(vtos(b.origin));
    dprint(" route="); dprint(ftos(b.qwtf_navroute));
    if (b.qwtf_nav) { dprint(" node="); dprint(vtos(b.qwtf_nav.origin)); }
    dprint(" stuck="); dprint(ftos(b.qwtf_stuck)); dprint("\n");
};
wrap void() worldspawn = { local entity t; prior(); t = spawn(); t.think = QWTF_bnp_think; t.nextthink = time + 1; };
#endif
