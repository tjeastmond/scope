interface GreetingProps {
  name: string;
}

const salutations: Record<string, string> = {
  de: "Grüß Gott",
  ja: "こんにちは",
  en: "Hello",
};

export const Größe = 42;

export function Greeting({ name }: GreetingProps) {
  return (
    <h2>
      {salutations.de}, {name} 👋
    </h2>
  );
}
