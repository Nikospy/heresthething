import { expect, test } from 'vitest';
import { wspolnaWersja } from '../../src/wspolne/protokol';

test('wspólna wersja: najwyższa w przecięciu, null gdy pusto albo od > do', () => {
  expect(wspolnaWersja({ od: 2, do: 3 }, { od: 2, do: 2 })).toBe(2);
  expect(wspolnaWersja({ od: 4, do: 4 }, { od: 2, do: 2 })).toBeNull();
  expect(wspolnaWersja({ od: 3, do: 2 }, { od: 2, do: 2 })).toBeNull();
});
