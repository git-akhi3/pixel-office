/** The demo mission: a task runs around the Helicarrier, every hero in turn. See director.ts for the commands. */
export const MISSION_SCRIPT = `
cinematic on
extras off
night on
camera at The Bridge
camera zoom 3
title "Pixel Office" 3
wait 1
gather The Bridge
say fury "Listen up. Mission #42 just came in from Slack: login with a one-time code." 5
say fury "Strange, plan it. Stark, build it. Banner, break it. Thor, you judge it." 5
say cap "On it, Director." 2
release all
wait 1

camera follow strange
work strange "#42 Plan the one-time code login"
say strange "I have seen 14 million ways to do this. One works." 4
wait 3
done strange
say strange "The plan is written. Stark, it is yours." 3
walk strange Stark Workshop
say strange "Build it exactly like this." 3
release strange

camera follow ironman
work ironman "#42 Build the one-time code login"
say ironman "Jarvis, scaffold the endpoint. Loki, the screen." 4
work loki "#42 Login screen" &
wait 4
say hulkbuster "Standing by, boss." 2
done loki
done ironman
say ironman "Done. Send it to the big guy." 3
release ironman

camera follow hulk
work hulk "#42 Smash-test the login"
say hulk "HULK TEST." 2
wait 2
say hulk "HULK FIND BUG." 3
done hulk
walk hulk Stark Workshop
say hulk "Code broke. Fix." 3
release hulk
work ironman "#42 Fix the expiry check"
wait 3
done ironman
work hulk "#42 Smash-test again"
wait 3
say hulk "Hulk... happy." 3
done hulk
release all

camera follow thor
work thor "#42 Review the login"
say thor "By Odin's beard, this code is worthy." 4
gate thor
say fury "Akhil, Thor wants a push. Your call." 4
wait 2
approve thor
done thor
release thor

camera follow spidey
work spidey "#42 Write the pull request"
say spidey "Your friendly neighbourhood PR writer, on it!" 4
done spidey
release spidey

camera at The Bridge
camera zoom 2
night auto
gather The Bridge
say fury "Mission #42 shipped. Shawarma, everyone." 4
release all
title "Pixel Office — your team, on deck" 4
end
`;
