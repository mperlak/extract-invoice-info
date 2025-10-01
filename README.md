# Extract Invoice Info

Prosty skrypt do jednorazowego miesięcznego przetwarzania faktur w formacie PDF z katalogu `in`, korzystający z `ai.sdk` i modelu OpenAI 4.1. Wynik to kopia PDF w katalogu `out` z nazwą `rrmmdd_nazwa`. Oryginał przenoszony jest do `processed`.

## Wymagania

- Node.js 18+
- Konto z dostępem do modelu OpenAI 4.1 (np. gpt-4.1-mini)
- Klucz API zapisany w `.env`

## Konfiguracja

1. Skopiuj `.env.example` do `.env` i ustaw `AI_SDK_API_KEY`. Opcjonalnie zdefiniuj `PROMPT_EXAMPLES`, np.:
   ```
   PROMPT_EXAMPLES="Shell Polska Sp. z o.o. => Shell\nORLEN Paliwo sp. z o.o. => Orlen"
   ```
2. Umieść faktury PDF w katalogu `in`.

## Uruchomienie

```bash
npm install
npm run build
npm start
```

Skrypt automatycznie utworzy katalogi `in`, `out`, `processed` (jeśli nie istnieją), przetworzy wszystkie PDF-y i przeniesie oryginały do `processed`.

## Uwaga

Wynik zależy od jakości OCR po stronie modelu. Zalecane jest ręczne sprawdzenie wyników.
