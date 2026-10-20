/** The demo mission: a task runs around the Helicarrier, every hero in turn. See director.ts for the commands. */
export const MISSION_SCRIPT = `
cinematic on
extras off
areas off
night off
music on
camera at The Bridge
camera zoom 2.5
title "PIXEL OFFICE" 3
title "One mission, start to finish" 2.5

# a field agent brings the brief in from Slack
camera at Quinjet Bay
camera zoom 3
arrive hill "Agent Hill (S.H.I.E.L.D.)" Quinjet Bay
say hill "Director. A new mission just landed in Slack." 3
camera follow hill
walk hill The Bridge
camera at The Bridge
camera zoom 2.5
gather The Bridge
handoff hill fury
say hill "Mission #42: sign-in with a one-time code." 3.5
say fury "Strange, plan it. Stark, build it. Banner, break it. Thor, you judge it. Parker, write it up." 6
say cap "Assemble." 2
release all
leave hill

# the plan
camera zoom 3
camera follow strange
work strange "#42 Plan the one-time code sign-in"
say strange "I have seen fourteen million ways to do this." 3.5
wait 1.5
say strange "One works." 2
done strange
handoff strange ironman
say strange "Build it exactly like this." 3
release strange

# the build
camera follow ironman
work ironman "#42 Build the one-time code sign-in"
work loki "#42 Sign-in screen" &
say ironman "Jarvis, scaffold the endpoint. Loki, make it pretty." 4
wait 2
say loki "Pretty is my whole brand." 3
say hulkbuster "Armour on standby." 2
done loki
done ironman
handoff ironman hulk
say ironman "Break it if you can, big guy." 3
release ironman
release loki

# the smash test, round one
camera follow hulk
work hulk "#42 Smash-test the sign-in"
say hulk "HULK TEST." 2
sound smash
shake 0.6 7
dust hulk
wait 1
say hulk "HULK FIND BUG. CODE EXPIRE WRONG." 3.5
done hulk
handoff hulk ironman
say hulk "Fix." 2
release hulk

# the fix and round two
camera follow ironman
work ironman "#42 Fix the expiry check"
say ironman "Off by one. Classic." 3
done ironman
handoff ironman hulk
release ironman
camera follow hulk
work hulk "#42 Smash-test again"
sound smash
shake 0.4 4
dust hulk
wait 1
say hulk "Hulk... happy." 3
done hulk
handoff hulk thor
release hulk

# the review
camera follow thor
work thor "#42 Review the sign-in"
say thor "By Odin's beard. Clean types, honest tests." 4
sound thunder
bolt thor
say thor "This code is worthy." 3
gate thor
say fury "Akhil, Thor wants to push. Your call." 4
wait 1.5
approve thor
done thor
handoff thor spidey
release thor

# the pull request
camera follow spidey
work spidey "#42 Write the pull request"
say spidey "Your friendly neighbourhood PR writer, on it." 4
done spidey
release spidey

# shipped
camera at The Bridge
camera zoom 2.5
gather The Bridge
sound fanfare
confetti The Bridge
say fury "Mission #42 shipped. Shawarma, everyone." 4
release all
title "Pixel Office. Your team, on deck." 4
music off
areas on
cinematic off
end
`;
