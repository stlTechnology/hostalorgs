// qwtf/medic_probe.qc -- TEST-ONLY probe for tests/test_medic.js. Not in the
// shipped build: compiled only with QWTF_EXTRA_QC=medic_probe.qc into a test dir.
//
// With the two bots on the server (qwtf_bots 1), it applies the medic's two
// effects through the shipped functions (QWTF_medkit_heal, QWTF_infect) on a
// timer, so no one has to aim a medkit, and prints what the server then holds:
//   t=4   Bot Red to 100, healed three times      -> QWTF_PROBE medic_heal hp=<n>
//   t=4   Bot Blue infected by Bot Red (hp 400, so the virus alone cannot kill)
//   t=8   Bot Red's health (overheal drains)       -> QWTF_PROBE medic_drain hp=<n>
//   t=16  Bot Blue still infected?                 -> QWTF_PROBE medic_virus infected=<0|1>
//   t=16  Bot Blue healed by its own side          -> QWTF_PROBE medic_cure infected=<0|1>

#ifdef __QW__

entity(string nm) QWTF_mp_find =
{
    local entity e;
    e = find(world, classname, "player");
    while (e)
    {
        if (e.netname == nm)
            return e;
        e = find(e, classname, "player");
    }
    return world;
};

void() QWTF_mp_think =
{
    local entity red, blue;

    red = QWTF_mp_find("Bot Red");
    blue = QWTF_mp_find("Bot Blue");
    self.nextthink = time + 1;
    if (!red || !blue)
        return;

    self.cnt = self.cnt + 1;
    if (self.cnt == 4)
    {
        red.health = 100;
        QWTF_medkit_heal(red);
        QWTF_medkit_heal(red);
        QWTF_medkit_heal(red);
        dprint("QWTF_PROBE medic_heal hp="); dprint(ftos(red.health)); dprint("\n");
        blue.health = 400;
        QWTF_infect(blue, red);
    }
    if (self.cnt == 8)
    {
        dprint("QWTF_PROBE medic_drain hp="); dprint(ftos(red.health)); dprint("\n");
    }
    if (self.cnt == 16)
    {
        dprint("QWTF_PROBE medic_virus infected=");
        dprint(ftos(blue.qwtf_poison_until > time)); dprint(" hp=");
        dprint(ftos(blue.health)); dprint("\n");
        QWTF_medkit_heal(blue);
        dprint("QWTF_PROBE medic_cure infected=");
        dprint(ftos(blue.qwtf_poison_until > time)); dprint("\n");
        remove(self);
    }
};

wrap void() worldspawn =
{
    local entity t;
    prior();
    t = spawn();
    t.think = QWTF_mp_think;
    t.nextthink = time + 1;
};

#endif
