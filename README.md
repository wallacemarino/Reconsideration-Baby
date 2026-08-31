# Reconsideration Baby

**Encourages guests who are leaving the park to reconsider when they encounter something that might change their minds.**

## What does it do?

In RollerCoaster Tycoon, once a guest decides to leave the park, there is normally very little you can do to change their mind. Even if they subsequently walk past something that could solve their problem, they remain focused on reaching the exit.

**Reconsideration Baby** adds a little more flexibility to that behaviour.

When a guest who is leaving encounters a plausible reason to stay, the plugin can clear their *leaving park* flag and allow the normal OpenRCT2 guest AI to decide what they want to do next.

It does **not** force guests to stay. An unhappy guest may reconsider, wander around for a while, satisfy a need or ride an attraction, and then decide to leave again. Guests can still leave the park normally.

## Reasons to reconsider

The plugin currently supports three optional triggers:

### Strongest need has relief nearby

If a departing guest has a significant need and encounters a nearby facility capable of relieving their strongest need, they can reconsider leaving.

This covers:

* Hunger → food stall
* Thirst → drink stall
* Toilet need → toilets
* Nausea → first aid

If two or more needs are equally strong, any appropriate facility can trigger reconsideration.

### Suitable ride encountered

A departing guest can reconsider if they encounter an open ride whose intensity falls within their preferred intensity range.

The guest is then returned to normal decision-making. They are **not forced to ride that attraction** and may choose to do something completely different.

### Entertainer encountered

Meeting an entertainer can persuade a departing guest to reconsider.

## Controls

Reconsideration Baby adds a window accessible from the OpenRCT2 map menu.

From there you can:

* Enable or disable the plugin
* Enable or disable each reconsideration trigger independently
* See how many guests have been persuaded to stay
* See how many guests are currently being tracked
* See which tracked guests are currently leaving the park
* Click a departing guest to centre the main viewport on them

## Diagnostics

The plugin includes a diagnostic panel showing exactly why a guest reconsidered.

Events identify the guest and the trigger responsible, for example:

`Guest 123 | NEED: thirst | leaving true -> false`

`Guest 456 | RIDE: Mine Train Coaster (6.42) | leaving true -> false`

`Guest 789 | ENTERTAINER | leaving true -> false`

Changes to the individual trigger settings are also logged, and the window displays their current internal ON/OFF states.

This makes it possible to see exactly when Reconsideration Baby has intervened rather than trying to infer it from the guest's subsequent behaviour.

## Performance

Reconsideration Baby is designed to avoid expensive full-park scans during normal play.

Guests are tracked incrementally, with a small portion of the general guest population checked each tick. Guests already known to be leaving receive priority checks so that brief encounters with possible reasons to reconsider are less likely to be missed.

Ride, facility and entertainer information is cached and updated when relevant park changes occur rather than repeatedly rebuilding everything at fixed intervals.

## Installation

1. Download the plugin `.js` file.
2. Place it in your OpenRCT2 `plugin` directory.
3. Start or restart OpenRCT2.
4. Open a park and select **Reconsideration Baby** from the map menu.
5. Enable the plugin and choose which reconsideration triggers you want to use.

## Philosophy

Reconsideration Baby is intended as a **guest-retention nudge**, not a way of imprisoning guests in your park forever.

Clearing the leaving flag gives a guest another opportunity to make their own decision using OpenRCT2's normal guest AI. If the underlying reasons for leaving remain, they may quickly decide to head for the exit again.

The aim is simply to give your park another chance to win them over.

## Compatibility

Designed for **OpenRCT2** and its JavaScript plugin API.

This plugin is not intended for the original, unmodified RollerCoaster Tycoon 2 executable.
