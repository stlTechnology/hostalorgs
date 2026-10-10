// Field declaration so qwtf_saw_credits is recognized on entity class
// This must be at module scope for fteqcc to recognize it as an entity field
.float qwtf_saw_credits;

#ifndef QWTF_NO_EGGS

// Touch handler: called when a player touches the credit trigger brush.
// Must be defined before trigger_qwtf_credits references it via self.touch = qwtf_credits_touch.

void() qwtf_credits_touch =
{
    // Only respond to players, not world or other entities.
    if (other.classname == "player")
    {
        // If this player hasn't seen the credits yet this life, show the message.
        // (If they already saw it, qwtf_saw_credits will be 1 and we skip.)
        if (other.qwtf_saw_credits != 1)
        {
            centerprint(other, "Built by Jason Wolff, with Claude Code (Opus 5.5), OpenCode (space bunny, via OpenRouter) and Nemotron");
            other.qwtf_saw_credits = 1;
        }
    }
};

// trigger_qwtf_credits - a trigger brush entity that, when a player touches it,
// prints a centerprinted credit message once per player per life.
//
// Usage: place a brush entity with classname "trigger_qwtf_credits" in the map.
// When a player touches it, they will see:
//   "Built by Jason Wolff, with Claude Code (Opus 5.5), OpenCode (space bunny, via OpenRouter) and Nemotron"
// printed in the center of their screen once per life.

void() trigger_qwtf_credits =
{
    // This is a trigger brush, so it uses the engine's touch function.
    // The message is printed via centerprint, which displays text in the center
    // of the player's screen.
    //
    // centerprint signature: void(entity client, string s) = #73
    // The 'other' is the player who touched this trigger.
    
    // Initialize the trigger brush (sets up model, collider, etc.).
    InitTrigger();
    
    // Set the touch function so the engine calls it when something touches this brush.
    self.touch = qwtf_credits_touch;
    
    // The message is shown by qwtf_credits_touch; nothing runs here at spawn,
    // where `other` is world (writing a field on world is a QuakeC runtime error).
};

wrap void() PutClientInServer =
{
    prior();
    self.qwtf_saw_credits = 0;
}

#endif // QWTF_NO_EGGS