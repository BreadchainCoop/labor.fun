# Attribution — house governance plugins

`chores.mjs`, `hearts.mjs`, and `things.mjs` are independent
reimplementations of the Chores, Hearts, and Things mechanisms designed by
Daniel Kronovet for **choreWheel**
(<https://github.com/zaratanDotWorld/choreWheel>, AGPL-3.0, © Zaratan LLC).

What was taken from choreWheel is the **mechanism design**: the point-accrual
model, poll-validity rules, vote thresholds, heart regen/karma/challenge
math, buy/proposal vote scaling, and the published default parameters
(documented in the choreWheel docs at <https://docs.chorewheel.zaratan.world>
and in Kronovet's mechanism papers). No choreWheel source code was copied;
these plugins are written from scratch against labor.fun's plugin surface
(file-based state, IPC announcements, reaction polling) and carry this
repository's MIT license.

If you want the full original system — including features these plugins
defer (PowerRanker preference ranking, breaks/working-percentage proration,
vote anonymization, resident deactivation, revives) — use choreWheel itself.
