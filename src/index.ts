import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { openai } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import type { CoreMessage } from 'ai';
import { z } from 'zod';

loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IN_DIR = path.join(__dirname, '..', 'in');
const OUT_DIR = path.join(__dirname, '..', 'out');
const PROCESSED_DIR = path.join(__dirname, '..', 'processed');

const responseSchema = z.object({
  issueDate: z
    .string()
    .regex(/^\d{6}$/)
    .describe('Data wystawienia faktury w formacie RRMMDD'),
  issuerName: z
    .string()
    .min(1)
    .describe('Przekształcona nazwa wystawcy zgodnie z instrukcjami'),
});

const promptTemplate = ({ examples }: { examples?: string }) => {
  const baseInstructions = `Twoje zadanie: odczytaj treść faktury (PDF) i zwróć:
- issueDate: data wystawienia w formacie RRMMDD (rok dwa cyfry, miesiąc dwa, dzień dwa) – jeśli brak pewności, oszacuj na podstawie kontekstu i zaznacz w polu issuerName "(niepewne)".
- issuerName: nazwa wystawcy znormalizowana według zasad poniżej.

Zasady dla issuerName:
- jeśli w pełnej nazwie pojawia się sieć stacji benzynowych (np. Shell, Orlen, BP), zwróć tylko nazwę sieci.
- usuń nadmiarowe elementy typu sp. z o.o., S.A., numer oddziału itp., chyba że to jedyna informacja identyfikująca.
- jeżeli brak rozpoznawalnej nazwy, zwróć użyteczne skrócone określenie, np. "Sklep spożywczy".
- jezeli w nazwie mamy formę dzialalnosci - np. sp. z o.o., S.A., przedsiębiorstwo wielobranowe czy FHU - zwróć tylko nazwę wystawcy z pominięciem formy dzialalnosci.
- jezeli faktura dotyczy stacji benzynowych - sprawdz jaki rodzaj paliwa jest na fakturze. W przypadku PB95 (benzyny bezolowiowej) - dodaj do nazwy pliku Mazda. Jezeli na fakturze jest ON (olej napędowy diesel) - dodaj do nazwy pliku Mercedes.
- jezeli faktura dotyczy noclegu (w jakimkolwiek jezyku) - dodaj do nazwy pliku hotel.

Wyjściowy format JSON:
{
  "issueDate": "RRMMDD",
  "issuerName": "..."
}`;

  if (examples && examples.trim().length > 0) {
    return `${baseInstructions}\n\nPrzykłady transformacji nazwy:\n${examples}`;
  }

  return baseInstructions;
};

async function ensureDirectories() {
  await fs.mkdir(IN_DIR, { recursive: true });
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(PROCESSED_DIR, { recursive: true });
}

function stripPolishDiacritics(value: string) {
  const polishMap: Record<string, string> = {
    ą: 'a',
    ć: 'c',
    ę: 'e',
    ł: 'l',
    ń: 'n',
    ó: 'o',
    ś: 's',
    ź: 'z',
    ż: 'z',
    Ą: 'A',
    Ć: 'C',
    Ę: 'E',
    Ł: 'L',
    Ń: 'N',
    Ó: 'O',
    Ś: 'S',
    Ź: 'Z',
    Ż: 'Z',
  };

  return value.replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (char) => polishMap[char] ?? char);
}

function sanitizeFilename(value: string) {
  const withoutPolish = stripPolishDiacritics(value);
  const normalized = withoutPolish
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  return normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

async function resolveUniquePath(targetPath: string) {
  const { dir, name, ext } = path.parse(targetPath);
  let attempt = 0;
  let candidate = targetPath;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fs.access(candidate);
      attempt += 1;
      candidate = path.join(dir, `${name}_${attempt}${ext}`);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return candidate;
      }
      throw error;
    }
  }
}

async function processFile(filePath: string, examples?: string) {
  const fileBuffer = await fs.readFile(filePath);
  const fileName = path.basename(filePath);
  const fileExtension = path.extname(fileName) || '.pdf';

  const messages: CoreMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'file',
          mediaType: 'application/pdf',
          data: fileBuffer,
        },
        {
          type: 'text',
          text: promptTemplate({ examples }),
        },
      ],
    },
  ];

  const result = await generateObject({
    model: openai('gpt-4.1-mini'),
    system: 'Jesteś ekspertem od ekstrakcji danych z faktur PDF.',
    messages,
    schema: responseSchema,
    maxRetries: 2,
  });

  const { issueDate, issuerName } = result.object;
  const sanitizedIssuer = sanitizeFilename(issuerName);
  const targetName = `${issueDate}_${sanitizedIssuer || 'brak_nazwy'}${fileExtension}`;
  const outPath = await resolveUniquePath(path.join(OUT_DIR, targetName));

  await fs.writeFile(outPath, fileBuffer);

  const processedPath = await resolveUniquePath(path.join(PROCESSED_DIR, fileName));
  await fs.rename(filePath, processedPath);

  console.log(`✔ Przetworzono ${fileName} → ${path.basename(outPath)} (data: ${issueDate}, wystawca: ${issuerName})`);
}

async function main() {
  const apiKey = process.env.AI_SDK_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Brak zmiennej środowiskowej AI_SDK_API_KEY lub OPENAI_API_KEY. Dodaj ją do pliku .env.');
  }

  if (!process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = apiKey;
  }

  await ensureDirectories();

  const entries = await fs.readdir(IN_DIR, { withFileTypes: true });
  const pdfFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
    .map((entry) => path.join(IN_DIR, entry.name));

  if (pdfFiles.length === 0) {
    console.log('Brak plików PDF w katalogu in.');
    return;
  }

  const examples = process.env.PROMPT_EXAMPLES;

  for (const file of pdfFiles) {
    try {
      await processFile(file, examples);
    } catch (error) {
      console.error(`✖ Błąd podczas przetwarzania ${path.basename(file)}:`, error);
    }
  }
}

main().catch((error) => {
  console.error('Nieoczekiwany błąd:', error);
  process.exitCode = 1;
});
