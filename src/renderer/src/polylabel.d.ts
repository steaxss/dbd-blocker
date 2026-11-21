declare module 'polylabel' {
  /** Pole of inaccessibility of a polygon (rings of [x, y]): the interior point farthest from the edges. */
  export default function polylabel(polygon: number[][][], precision?: number, debug?: boolean): [number, number] & { distance: number }
}
