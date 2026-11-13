# FastChat user manual

## The window

On the left is the sidebar, with the list of conversations. In the centre is the conversation, with the message box at the bottom. On the right is the conversation panel, with the “Model”, “Situation” and “Knowledge” tabs.

The panel is hidden and shown with the button at the top right, next to the export icon.

## Starting a conversation

“New conversation”, in the sidebar, opens a conversation with the “Generalist” role: no instructions, the model as it is.

The arrow next to “New conversation” opens “Talk to a…”: the list of installed roles, then the templates. Clicking a role opens a conversation with that role.

The model is chosen from the “Model” menu, in the top bar.

## Roles

A role tells the model who it is and how it should answer. It is adjusted in the “Model” tab, which shows the role and its sections: “Identity and goals”, “Style and format”, “Rules”, “Method”.

Each section opens with a click and contains the role's choices. When closed, it shows the current choices on one line. Some choices also change the model's settings: a line under the choice says so, for example “sets temperature to 0.3”.

To change role, use “Change…”, next to the role's name. In an empty conversation the role changes straight away. In a conversation that has already started, a new conversation opens, which can start from the summary of the previous one.

## Situation

In the “Situation” tab you write the context of this conversation, in your own words: what it is about, who it is for, which constraints apply. It saves by itself and applies from the next question.

Under the box is the character counter. “What the model receives” shows the complete instructions: the role's, then the situation.

The same tab holds “Plan mode” and “Save as template”.

## Documents and knowledge bases

In the “Knowledge” tab, “Add documents” loads the files the model should answer from. They can also be dragged into the box.

“Use the knowledge base” turns the use of documents on or off for the whole conversation. The book-shaped button next to “Send” applies to a single question.

“Link a knowledge base…” links a base from the library to the conversation. Library bases are created in “Settings” → “Knowledge” tab.

The bases under “From the role” are part of the role: they are always active and cannot be unlinked.

## How the model answers

In the “Model” tab, under the role's sections, there are four groups: “Where it runs”, “How it picks words”, “How it answers”, “What it remembers”.

“How it answers” holds “Reasoning” and “Answer style”, with four values: “Essential”, “Concise”, “Normal”, “Extended”. “How it picks words” holds “Temperature”. “What it remembers” holds “Conversation memory”.

“Reasoning”, “Plan mode” and “Style” are also found under the message box.

“↺ All suggested values” brings temperature and memory back to the values recommended for the model.

## Plan mode

With “Plan mode” on, the send button becomes “Plan”. The model proposes a plan in steps; the steps can be edited. “Approve and run” starts the answer that follows the plan.

## Long conversations

When the conversation no longer fits in the model's memory, the oldest messages are replaced by an “Automatic summary”, visible in the conversation. It can be read and corrected with “Show and edit”, redone with “Refresh”, removed with “Delete”.

“Context status”, at the bottom of the “Model” tab, shows how much memory is in use.

## Store

“Store”, at the bottom of the sidebar, lists what can be installed: “Roles”, “Knowledge bases”, “Plugins”, “Bundles”.

“Install” adds the item; “Remove” takes it away. A role is installed together with the bases it requires. When a role exists in several languages, “Available in:” lets you choose which one to install.

## Templates and export

“Save as template”, in the “Situation” tab, saves the role, the choices and the situation. The template is then found in “Talk to a…”.

The export icon, at the top right, saves the conversation as Markdown or JSON.

## Settings

The gear at the bottom of the sidebar opens “Settings”, with the “General”, “Models”, “Ollama”, “Knowledge” and “Context” tabs.

In “General” you choose “Language”, “Theme”, “Ollama URL” and “Default model”. In “Knowledge” you manage the library bases and import a package with “Import package…”.
