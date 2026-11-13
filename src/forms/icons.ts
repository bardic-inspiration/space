// The studio's built-in icons, drawn on a canvas, and the faces of cards.
// An icon is a name from this set, or one or two characters of text.

type Paint = (context: CanvasRenderingContext2D, size: number) => void;

const polygon = (points: [number, number][]): Paint => (context, size) => {
  context.beginPath();
  points.forEach(([x, y], index) => (index === 0 ? context.moveTo(x * size, y * size) : context.lineTo(x * size, y * size)));
  context.closePath();
  context.fill();
};
const circle = (context: CanvasRenderingContext2D, x: number, y: number, r: number) => {
  context.beginPath();
  context.arc(x, y, r, 0, Math.PI * 2);
  context.fill();
};
const star = (points: number, inner: number): [number, number][] =>
  Array.from({ length: points * 2 }, (_, i): [number, number] => {
    const r = i % 2 === 0 ? 0.36 : inner;
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    return [0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r];
  });

export const ICONS: Record<string, Paint> = {
  dot: (context, size) => circle(context, size / 2, size / 2, size * 0.2),
  ring: (context, size) => {
    context.lineWidth = size * 0.09;
    context.beginPath();
    context.arc(size / 2, size / 2, size * 0.25, 0, Math.PI * 2);
    context.stroke();
  },
  square: polygon([[0.24, 0.24], [0.76, 0.24], [0.76, 0.76], [0.24, 0.76]]),
  triangle: polygon([[0.5, 0.18], [0.82, 0.76], [0.18, 0.76]]),
  diamond: polygon([[0.5, 0.14], [0.8, 0.5], [0.5, 0.86], [0.2, 0.5]]),
  star: polygon(star(5, 0.15)),
  gear: polygon(star(8, 0.26)),
  cross: polygon([[0.4, 0.16], [0.6, 0.16], [0.6, 0.4], [0.84, 0.4], [0.84, 0.6], [0.6, 0.6], [0.6, 0.84], [0.4, 0.84], [0.4, 0.6], [0.16, 0.6], [0.16, 0.4], [0.4, 0.4]]),
  crown: polygon([[0.18, 0.74], [0.18, 0.3], [0.34, 0.5], [0.5, 0.24], [0.66, 0.5], [0.82, 0.3], [0.82, 0.74]]),
  shield: polygon([[0.22, 0.2], [0.78, 0.2], [0.78, 0.52], [0.5, 0.86], [0.22, 0.52]]),
  bolt: polygon([[0.56, 0.12], [0.26, 0.56], [0.46, 0.56], [0.4, 0.88], [0.74, 0.42], [0.54, 0.42]]),
  paw: (context, size) => {
    circle(context, size * 0.5, size * 0.62, size * 0.17);
    for (const [x, y] of [[0.26, 0.42], [0.42, 0.28], [0.58, 0.28], [0.74, 0.42]]) circle(context, size * x, size * y, size * 0.075);
  },
  bot: (context, size) => {
    context.fillRect(size * 0.26, size * 0.34, size * 0.48, size * 0.4);
    context.fillRect(size * 0.47, size * 0.18, size * 0.06, size * 0.16);
    circle(context, size * 0.5, size * 0.17, size * 0.05);
    context.clearRect(size * 0.36, size * 0.46, size * 0.08, size * 0.08);
    context.clearRect(size * 0.56, size * 0.46, size * 0.08, size * 0.08);
  },
};

/** Paints an icon by name, or one or two characters of text, centred in a square. */
export function paintIcon(context: CanvasRenderingContext2D, icon: string, size: number, color: string): void {
  context.clearRect(0, 0, size, size);
  context.fillStyle = color;
  context.strokeStyle = color;
  const paint = ICONS[icon];
  if (paint) return paint(context, size);
  const text = [...icon].slice(0, 2).join('');
  context.font = `600 ${size * (text.length > 1 ? 0.46 : 0.6)}px system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, size / 2, size / 2 + size * 0.04);
}

export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export const SUIT_SIGNS: Record<string, string> = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };
export const RED_SUITS = new Set(['diamonds', 'hearts']);

/** A rank as a card shows it: 11 to 14 are J, Q, K and A. */
export const rankText = (rank: unknown): string => (typeof rank === 'number' ? ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 1: 'A' } as Record<number, string>)[rank] ?? String(rank) : String(rank ?? ''));
/** A suit by name, or by number in the order clubs, diamonds, hearts, spades. */
export const suitName = (suit: unknown): string => (typeof suit === 'number' ? SUITS[((suit % 4) + 4) % 4] : String(suit ?? ''));

/** Paints a suit's pip in a box of `size` centred on `(x, y)`. */
export function paintSuit(context: CanvasRenderingContext2D, suit: string, x: number, y: number, size: number): void {
  const s = size / 2;
  context.beginPath();
  if (suit === 'diamonds') {
    context.moveTo(x, y - s);
    context.lineTo(x + s * 0.75, y);
    context.lineTo(x, y + s);
    context.lineTo(x - s * 0.75, y);
  } else if (suit === 'hearts' || suit === 'spades') {
    const flip = suit === 'spades' ? -1 : 1;
    context.moveTo(x, y + flip * s);
    context.bezierCurveTo(x - s * 1.6, y - flip * s * 0.1, x - s * 0.7, y - flip * s * 1.3, x, y - flip * s * 0.45);
    context.bezierCurveTo(x + s * 0.7, y - flip * s * 1.3, x + s * 1.6, y - flip * s * 0.1, x, y + flip * s);
    if (suit === 'spades') {
      context.moveTo(x, y);
      context.lineTo(x + s * 0.4, y + s);
      context.lineTo(x - s * 0.4, y + s);
    }
  } else if (suit === 'clubs') {
    for (const [dx, dy] of [[0, -0.45], [-0.48, 0.15], [0.48, 0.15]]) {
      context.moveTo(x + dx * s + s * 0.42, y + dy * s);
      context.arc(x + dx * s, y + dy * s, s * 0.42, 0, Math.PI * 2);
    }
    context.moveTo(x, y);
    context.lineTo(x + s * 0.35, y + s);
    context.lineTo(x - s * 0.35, y + s);
  } else return;
  context.closePath();
  context.fill();
}
