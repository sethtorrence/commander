# Commander privacy policy

Commander is a personal desktop app. It runs entirely on your own computer, and it has no server: its developer never receives your data.

## What Commander reads

When you connect an account, Commander reads what you allow on its consent screen: for Google, your Gmail messages and labels, your Google Calendar events and calendar list, and your name and email address; likewise for Microsoft (Outlook mail, Outlook Calendar, Teams Chats), Linear and GitHub.

## Where your data is kept

- Everything Commander syncs is stored only on your computer, in a local database in your user profile.
- Sign-in tokens and API keys are stored only in your operating system's keyring, never in plain text.
- Commander keeps a short log of what it did (syncs, failures, restarts) on your computer, for a week at most. It never holds tokens, keys, email text or what your items say. Settings → Diagnostics can export it to a file you choose, for example to attach to a bug report; nothing is sent anywhere unless you send that file yourself.
- Removing an account in Settings → Accounts deletes its token and the data Commander synced from it.

## Who else sees it

- **The services themselves.** Commander talks directly to Google, Microsoft, Linear and GitHub to read your data and to make the changes you ask for (archiving an email, replying to an invitation, and so on).
- **The AI model provider, only if you turn Ares on.** Ares, Commander's assistant, sends the material a task needs (for example, an email's text to sort it into a Bucket, or a thread and some of your own sent mail to draft a reply in your style) to the model provider you configure in Settings → Ares, currently Z.ai. Nothing is sent until you add a model API key. Commander keeps a record of usage and cost, but not of what was sent.
- **Hugging Face, once, for the search model.** Search by meaning runs a small embedding model on your computer. Commander downloads its files once from Hugging Face (huggingface.co); that download sends nothing of yours. Your data is embedded on your computer and never leaves it. You can turn search by meaning off in Settings → Ares.
- **No one else.** Commander has no analytics, no tracking and no advertising, and it never sells or shares your data.

## Google user data

Commander's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. Google user data is used only to provide Commander's features to you, is never used for advertising, and is never transferred to others except the AI model provider described above, at your choice, to provide those features.

## Contact

Seth Torrence, seth@storrence.dev
