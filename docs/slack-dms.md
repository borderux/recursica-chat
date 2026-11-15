# Slack DMs for mentions

A person can get a Slack DM when someone mentions the person in CircleChat. CircleChat keeps each person's Slack member ID and checks that the ID belongs to the person. CircleChat holds no Slack token. A notifier outside CircleChat holds the Slack bot token, sends the codes and sends the DMs.

## What a person sees

**After any sign-in, a modal asks once for the person's Slack member ID.** The modal asks each person with no verified ID, on a new account or an older one. A Google sign-in, a password sign-in and a sign-up each count. Skip, a close or a verified ID ends the asking for good.

**Settings → Profile has the same field,** under "Slack DMs", to add, change or remove the ID. A changed ID gets no DM until the person verifies the new ID. The old ID keeps the DMs until then. Remove stops the DMs at once.

**Each field shows where Slack shows the ID:** "In Slack, click your profile picture, then Profile, then the ⋯ button, then Copy member ID." A member ID starts with U or W, such as `U0123ABCD`.

## How a person proves the ID

1. The person types the ID and presses "Send code". CircleChat keeps the ID as pending, and sends the database notice `slack_code` with the person's user ID.
2. The notifier makes a 6-digit code and writes the code's salt and hash. The notifier then sends the code to the pending ID as a Slack DM. The code itself is never stored.
3. The person types the code. CircleChat hashes the typed code with the salt and compares the two hashes. On a match, the pending ID becomes the verified ID.

**Limits on a code:**

- A code works for 10 minutes.
- A code works for 5 tries. A wrong code costs one try.
- A person asks for at most 3 codes an hour, so nobody can make the bot DM a stranger often.
- Two people can't verify the same Slack ID.

**Only the person sets the person's own ID.** Each route takes a person's session and works on that person's own row. No route takes another person's user ID. An agent's bot token and a service token can't reach the routes. The spectator mode can't either.

| Route                             | What the route does                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /api/users/me/slack`         | Shows the verified ID, the pending ID, the code's state and whether the modal asks. Never the salt or the hash |
| `POST /api/users/me/slack`        | `{ "slackUserId" }`: keeps the ID as pending and asks for a code                                              |
| `POST /api/users/me/slack/verify` | `{ "code" }`: checks the code                                                                                 |
| `DELETE /api/users/me/slack`      | Removes the verified ID and the pending ID                                                                    |
| `POST /api/users/me/slack/skip`   | Closes the modal for good                                                                                     |

## The table

`user_slack` holds one row for each person who typed an ID or closed the modal (`api/migrations/fork/0004_user_slack.sql`).

| Column                                      | Written by   | Meaning                                                           |
| ------------------------------------------- | ------------ | ----------------------------------------------------------------- |
| `slack_user_id`, `verified_at`              | CircleChat   | The verified ID. Only this ID gets a DM about a mention           |
| `pending_slack_user_id`, `code_requested_at` | CircleChat   | The typed ID that waits for a code, and when the person asked     |
| `code_salt`, `code_hash`                    | The notifier | The salt, and SHA-256 of `<salt>:<code>` in hex                   |
| `code_sent_at`, `code_expires_at`           | The notifier | When the code went out, and 10 minutes later                      |
| `send_error`                                | The notifier | Slack's error for a DM that failed, such as `user_not_found`      |
| `code_attempts`                             | Both         | Wrong tries. The notifier sets 0 with a new code                  |
| `prompt_closed_at`                          | CircleChat   | When the person skipped or closed the modal, or verified an ID    |

## What a notifier does

1. **Listen** for the notice `slack_code`, and also check every 30 seconds.
2. **Find each row that waits for a code:** `pending_slack_user_id` and `code_requested_at` are set, and `code_sent_at` and `send_error` are empty.
3. **Make the code** with a secure random number, from 000000 to 999999, and a new random salt.
4. **Write the salt, the hash, `code_sent_at` and `code_expires_at`,** and set `code_attempts` to 0. Write only where `code_requested_at` is unchanged, so a newer request wins.
5. **Send the code to the pending ID** as a Slack DM. Name the person's CircleChat handle and the CircleChat address in the DM. Say that the person can ignore a code the person didn't ask for.
6. **When Slack refuses the DM,** write Slack's error to `send_error` and clear the salt and the hash.
7. **Send a DM about a mention to `slack_user_id` only,** never to `pending_slack_user_id`.

**A notifier never stores or logs the code.** A notifier writes only the columns in step 4 and step 6. Give the notifier a database role that can read the tables the notifier reads, and update only those columns.
