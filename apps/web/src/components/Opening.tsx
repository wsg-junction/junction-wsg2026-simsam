import { useEffect, useState } from 'react';
import { Button, Form, Input, Spinner, TextField } from '@heroui/react';
import { serverFeatures } from '../lib/ai';
import { PhotoError, preparePhoto, searchByPhoto } from '../lib/image';
import { PhotoButton } from './PhotoButton';
import { useVoiceControls, VoiceButtons, VoiceStatusRows } from './VoiceControls';

const EXAMPLES = [
  'How did Finland become independent in 1917?',
  'How did the printing press change Europe?',
  'What did Alan Turing contribute to computer science?',
  'Why did the Hanseatic League decline?',
];

export function Opening({ onExplore }: { onExplore: (question: string, deep?: boolean) => void }) {
  const [question, setQuestion] = useState('');
  const [deepOn, setDeepOn] = useState(false);
  const [imageOn, setImageOn] = useState(false);
  const [photo, setPhoto] = useState<{ status: 'reading' } | { status: 'error'; message: string } | null>(null);
  useEffect(() => {
    let live = true;
    serverFeatures().then((h) => {
      if (!live) return;
      setDeepOn(h?.deep === true);
      setImageOn(h?.image === true);
    });
    return () => {
      live = false;
    };
  }, []);
  // Spoken questions start an exploration straight away, like pressing Explore.
  const voice = useVoiceControls(onExplore);

  // A photo: the server keeps it and has the AI read it, then the exploration starts from what it saw.
  async function searchPhoto(file: File) {
    setPhoto({ status: 'reading' });
    try {
      const { blob } = await preparePhoto(file);
      const seen = await searchByPhoto(blob);
      setPhoto(null);
      onExplore(seen.query);
    } catch (err) {
      setPhoto({ status: 'error', message: err instanceof PhotoError ? err.message : 'The photo couldn’t be read right now.' });
    }
  }

  function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    const q = question.trim();
    if (q) onExplore(q);
  }

  return (
    <section
      aria-labelledby="opening-title"
      className="relative flex min-h-full flex-col justify-center px-6 py-16 sm:px-12 lg:px-20"
    >
      <div className="cartouche relative max-w-3xl">
        <h1
          id="opening-title"
          className="font-serif text-[clamp(2.25rem,5.5vw,4.25rem)] leading-[1.05] font-normal tracking-[-0.015em] text-balance"
        >
          What do you want to explore?
        </h1>

        <Form onSubmit={submit} className="mt-8 flex flex-col gap-4 md:flex-row md:items-end">
          <TextField
            aria-labelledby="opening-title"
            name="question"
            value={question}
            onChange={setQuestion}
            className="question-transition flex-1"
            autoFocus
          >
            <Input
              placeholder="A person, place, idea or event"
              className="question-input font-serif text-xl sm:text-2xl"
            />
          </TextField>
          <div className="flex shrink-0 flex-wrap items-center gap-2 max-md:w-full">
            <div className="flex items-center gap-2 max-md:w-full">
            {imageOn && <PhotoButton size="lg" onFile={(f) => void searchPhoto(f)} isPending={photo?.status === 'reading'} />}
              <VoiceButtons controls={voice} size="lg" />
            </div>
            <Button type="submit" size="lg" className="shrink-0 max-md:flex-1">
              Explore
            </Button>
            {deepOn && (
              <Button
                size="lg"
                variant="secondary"
                className="shrink-0 max-md:flex-1"
                isDisabled={!question.trim()}
                onPress={() => question.trim() && onExplore(question.trim(), true)}
              >
                Deep research
              </Button>
            )}
          </div>
        </Form>
        <VoiceStatusRows controls={voice} rowClassName="mt-4" />
        {photo && (
          <p role="status" className="mt-4 inline-flex items-center gap-2 text-sm text-muted">
            {photo.status === 'reading' ? (
              <>
                <Spinner size="sm" aria-hidden />
                Looking at your photo…
              </>
            ) : (
              photo.message
            )}
          </p>
        )}

        <p className="mt-3 text-sm text-muted">
          Answers are mapped from Wikipedia articles, with every passage linked to its source.
          {deepOn && ' Deep research writes a full report on a topic, with a timeline, parts, figures and sources.'}
        </p>

        <div className="mt-14">
          <h2 className="text-sm font-medium text-muted">Start from a question</h2>
          <ul className="mt-3 flex flex-col items-start gap-1">
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  onClick={() => onExplore(example)}
                  className="group flex items-center gap-3 rounded-md py-1.5 pr-2 text-left font-serif text-lg text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full border border-[var(--chart-node)] transition-colors group-hover:border-accent group-hover:bg-accent motion-reduce:transition-none"
                  />
                  {example}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
