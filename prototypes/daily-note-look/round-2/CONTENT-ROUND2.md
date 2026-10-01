# PROTOTYPE round 2 content (adds to ../CONTENT.md)

All of `../CONTENT.md` still applies: the same Daily Note for Thursday 1 October 2026 and the earlier days. Round 2 adds Titanus.

## Titanus

Titanus is the Agent's name: Commander's JARVIS. He is a soft-spoken, calm man, straight to the point, very intelligent but easy to talk to. He explains things in the plainest possible words, short sentences, no jargon, as if to someone hearing it for the first time. He is never chirpy, never uses exclamation marks or emoji, and never says "I'm happy to help".

Wherever round 1 said "Agent noticed" or "Agent suggestion", the UI now speaks as Titanus (e.g. "Titanus noticed", "Suggested by Titanus"). The domain term stays "Agent" in code and docs; "Titanus" is what the User sees.

## Titanus never interrupts

Titanus does not pop up or talk unprompted. He **queues** things he wants to tell the User and waits until the User **asks for an update**, and only while the User is active. The UI should show, quietly:

- whether the User is active (e.g. "You're here"); after a while with no input it can show the User as away;
- how many things Titanus has queued (e.g. "Titanus has 4 things for you");
- a clear way to ask for an update (a button, plus a key such as `U` when not typing).

Asking for an update opens Titanus's update, in his voice. Use these four queued items:

1. **Dana is waiting on you.** She asked which dates work for the Q4 offsite. You haven't answered yet. It's a short reply.
2. **Priya still can't get into the Acme sandbox.** You wrote it down in your 1:1. Nobody has done it yet. It takes a minute.
3. **The Acme decision is due Friday.** Your call with them is at four today. If you decide on the call, you're done early.
4. **ENG-412 has been In Progress for six days.** That's longer than these usually take. Priya might be stuck. Worth a quick question.

Each item can be marked done or dismissed; the count goes down.

## Talking to Titanus (hint only)

Typed conversation with Titanus comes later. A single, quiet hint of it is welcome (e.g. a disabled "Ask Titanus… (coming later)" line), but do not build chat.
