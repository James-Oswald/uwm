export type ParsedCoordinateInput = {
  x: number;
  y: number | null;
  z: number;
};

export function parseCoordinateInput(rawInput: string): ParsedCoordinateInput | null {
  const matches = rawInput.match(/-?\d+(?:\.\d+)?/g);
  if (!matches) {
    return null;
  }

  if (matches.length !== 2 && matches.length !== 3) {
    return null;
  }

  const values = matches.map((match) => Number(match));
  if (values.some((value) => !Number.isFinite(value))) {
    return null;
  }

  if (values.length === 2) {
    return {
      x: values[0],
      y: null,
      z: values[1],
    };
  }

  return {
    x: values[0],
    y: values[1],
    z: values[2],
  };
}
