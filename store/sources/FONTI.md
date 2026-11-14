# Fonti dei testi dell'Esperto di prompt engineering

Questo file non entra in nessun pacchetto: registra da dove vengono i testi di `prompt-tecniche.*.md` e
`prompt-esempi.*.md`, che sono sintesi, traduzioni e adattamenti.

## Tecniche di prompt

Sintesi delle guide ufficiali:

- Anthropic, «Prompting best practices» — https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- Google, «Prompt design strategies» — https://aistudio.google.com/docs/prompting-strategies
- Google, «Gemma 4 Prompt Formatting» — https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4
- OpenAI, «Prompt engineering» — https://developers.openai.com/api/docs/guides/prompt-engineering

## Prompt deboli e migliorati

| Esempio | Provenienza |
|---|---|
| Aggiungere i dettagli che mancano | Coppia «peggio/meglio» della guida di OpenAI («Summarize the meeting notes»), tradotta. |
| Migliorare un prompt del tipo «Agisci come…» | Prompt di partenza: «Storyteller» da `f/awesome-chatgpt-prompts` (testi dei prompt in pubblico dominio, CC0 1.0), tradotto. Versione migliorata scritta per FastChat. |
| Scrivere un prompt il cui risultato va letto da un programma | Esempio di classificazione delle recensioni dalla guida di OpenAI (sezione sugli esempi), tradotto e adattato. |
| Scrivere un prompt di sistema da riusare | Adattamento e traduzione del pattern `summarize` di `danielmiessler/fabric` (licenza MIT, Copyright (c) 2012-2024 Scott Chacon and others). |
| Spiegare cosa non va in un prompt | Prompt di partenza: «Essay Writer» da `f/awesome-chatgpt-prompts` (CC0 1.0), tradotto. Diagnosi scritta per FastChat. |
| Quando l'obiettivo non è chiaro | Scritto per FastChat. |

Le spiegazioni «Perché è scritto così» sono scritte per FastChat.
