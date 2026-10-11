# Testing corrections

Collect issues found during hands-on testing here. Address them together after the testing pass.

## Onboarding

- [x] Accept a timetable in any useful form instead of asking specifically for a photo. _(completed in 0.2.1)_
  - The prompt should invite an image, PDF, document, pasted text, or a manually typed schedule.
  - Route each supported format through the appropriate extraction path.
  - Show the extracted courses and class times for confirmation before saving them.
  - If the supplied content cannot be read as a timetable, explain what failed and ask for another format.

- [x] Fix timetable confirmation being intercepted by the generic onboarding prompt. _(completed in 0.2.1)_
  - Reproduction: enter a name, send a valid timetable image, then reply `yes` to the extracted preview.
  - Current result: the timetable is parsed successfully, but `yes` receives “Send me your current timetable…” again.
  - Cause: `OnboardingService.handle()` treats every non-image/document message in `awaiting_timetable_confirmation` as a missing timetable, so `DmService.finishOnboardingTimetable()` is never reached.
  - Expected: `yes` saves the pending timetable and advances to the reminder-time question; `no` discards it and requests another timetable; other replies ask specifically for `yes` or `no`.

## Correctness

- [x] Stop timetable detection from running on every registered-user DM. _(completed in 0.2.2)_
  - Typed timetable support must apply during onboarding and explicit timetable updates only.
  - Ordinary questions must not invoke the timetable model before reaching the agent.

- [x] Accept the student's exact class-reminder lead time. _(completed in 0.2.2)_
  - `15mins` should set a 15-minute reminder instead of claiming only 30 minutes or one hour is supported.
  - Keep the existing safe minimum and maximum validation.

- [x] Add one consolidated course-overview retrieval path. _(completed in 0.2.2)_
  - Broad questions such as “what information do you have about my courses?” must not call `get_course_info` once per course.
  - Return all tracked courses, timetable information, announcements and known details in one bounded result.
  - Never claim a course “didn't come through” merely because the agent exhausted its tool-call budget.

- [x] Prevent duplicated times in alerts. _(completed in 0.2.2)_
  - Example to fix: `Wednesday 4pm 4pm, ELT`.
  - Structured date/time formatting must not repeat a time already embedded in the generated title.

- [x] Preserve uncertainty from voice-note transcription through to the answer. _(completed in 0.2.2)_
  - Low-confidence transcripts must be qualified rather than presented as certain.
  - Never silently change an ambiguous code such as `ED 573` into `ABE 573`; state the likely interpretation and uncertainty.

## Group identity and authority

- [x] Build a group participant directory from live WhatsApp metadata. _(completed in 0.2.2)_
  - Store the stable LID/JID and phone number when WhatsApp exposes it; do not infer a phone number from a LID.
  - Preserve group-message sender identity reliably, including wrapped Baileys message forms where the current logs show `sender: null`.
  - Keep participant identity scoped to the group it came from.

- [x] Let verified current members ask for their group's visible participant list or a member's number. _(completed in 0.2.2)_
  - Verify current membership at request time.
  - Return only identities WhatsApp exposes in that group.
  - Never provide a cross-group contact dump, information from a group the requester cannot access, or proactively message participants.
  - Resolve duplicate or ambiguous display names before returning one person's number.

- [x] Bind trusted lecturer and class-rep roles to stable participant identities. _(completed in 0.2.2)_
  - A statement such as “Khalil is our class rep” should resolve to that group's participant identity, not only a mutable display name.
  - Keep name matching only as a temporary fallback until the person posts or can be resolved unambiguously.
  - Being a WhatsApp group admin must not automatically grant lecturer or class-rep authority.

- [x] Apply explicit contradiction rules using trusted identities. _(completed in 0.2.2)_
  - Lecturer information outranks class-rep and student information.
  - Class-rep information outranks ordinary student information.
  - Conflicting sources with equal authority must both be shown with sender and time rather than silently choosing one.

## Performance

- [x] Avoid a full live membership reconciliation before every DM response. _(completed in 0.2.2)_
  - Cache or throttle reconciliation while retaining an explicit refresh path and current-membership checks for sensitive operations.
  - Remove repeated multi-group checks from the normal response latency.

## Response quality

- [x] Make broad course summaries concise and factual. _(completed in 0.2.2)_
  - Remove repetitive filler such as “Want to check for updates?” after every course.
  - Mention follow-up options once after the facts.

- [x] Use WhatsApp formatting consistently. _(completed in 0.2.2)_
  - Use `*bold*`, not Markdown `**bold**`.

- [x] Keep answers grounded in tool completion state. _(completed in 0.2.2)_
  - Distinguish “no information exists” from “a lookup was skipped, capped, timed out or failed.”
  - Do not turn an internal execution limit into a factual statement to the student.
