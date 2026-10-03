# Peermate — Student Guide

Peermate is a private WhatsApp assistant for students. It quietly follows approved
groups shared by the student and Peermate, remembers what is posted, and helps the
student find information, files and reminders without searching every chat.

## Getting started

1. Message Peermate and provide your name.
2. Send a photo or file of your timetable. Peermate extracts the courses and class
   times, shows them for confirmation, and asks how long before each class it should
   remind you.
3. Add Peermate to the relevant WhatsApp groups. Peermate remains silent in groups.
   When it detects a new group, it privately notifies each registered student whose
   current membership it can confirm, including the group's name and member count.
   Each student receives this notice once, regardless of who added Peermate.
4. Ask **"Which groups are we in together?"** to see the live list from WhatsApp.
5. Tell Peermate which courses each group covers. One course may use several groups,
   and a general group may provide information for several courses.

After setup, ask naturally, for example:

- “What did I miss today?”
- “Is the CVE 575 test still on Thursday?”
- “What venue did the class rep post?”
- “Find the voice note about the assignment.”
- “Send me the image or file that announcement came from.”
- “Remind me 30 minutes before tomorrow's class.”

## What Peermate handles

- Text messages, images and voice notes posted after Peermate joins an approved group.
- Questions across any live group shared by Peermate and the student.
- Timetables, course reminders, tests, assignments, deadlines, venues and changes.
- Conflicting or corrected information, with the source, sender and time shown.
- Original images, voice notes and files, returned privately on request.
- PDFs stored with their filename and source. Their contents are processed only when
  a student asks Peermate to read, explain, search or create study material from them.

Peermate never posts in a group. It answers and sends alerts only in the student's
private chat. It never initiates a private conversation with an unregistered group
member. Stored source information is not automatically trimmed because of age; it
remains recoverable until an authorised deletion or forget request is made.

## Development versions

Development replies are headed **DEV TESTING**. `DATA_VERSION` namespaces MongoDB and
search data; changing it gives every student a clean slate while leaving the previous
version intact for deliberate cleanup later.
