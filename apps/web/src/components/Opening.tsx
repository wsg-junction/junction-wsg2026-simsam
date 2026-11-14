import { useEffect, useState } from 'react';
import { Button, Form, Input, TextField } from '@heroui/react';
import { serverFeatures } from '../lib/ai';
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
  useEffect(() => {
    let live = true;
    serverFeatures().then((h) => live && setDeepOn(h?.deep === true));
    return () => {
      live = false;
    };
  }, []);
  // Spoken questions start an exploration straight away, like pressing Explore.
  const voice = useVoiceControls(onExplore);

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

        <Form onSubmit={submit} className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-end">
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
          <div className="flex shrink-0 items-center gap-2">
            <VoiceButtons controls={voice} size="lg" />
            <Button type="submit" size="lg" className="shrink-0">
              Explore
            </Button>
            {deepOn && (
              <Button
                size="lg"
                variant="secondary"
                className="shrink-0"
                isDisabled={!question.trim()}
                onPress={() => question.trim() && onExplore(question.trim(), true)}
              >
                Deep research
              </Button>
            )}
          </div>
        </Form>
        <VoiceStatusRows controls={voice} rowClassName="mt-4" />

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
