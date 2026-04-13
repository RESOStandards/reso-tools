import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInfiniteScroll } from '../src/hooks/use-infinite-scroll';

/**
 * Mock IntersectionObserver and capture the most-recent callback so
 * tests can drive the sentinel into and out of view manually.
 */
interface ObserverHandle {
  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit | undefined;
  readonly observe: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn>;
}

const observers: Array<ObserverHandle> = [];

class MockIntersectionObserver {
  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit | undefined;
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  readonly unobserve = vi.fn();
  readonly takeRecords = vi.fn(() => []);
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds: ReadonlyArray<number> = [];

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit
  ) {
    this.callback = callback;
    this.options = options;
    observers.push({
      callback,
      options,
      observe: this.observe,
      disconnect: this.disconnect
    });
  }
}

beforeEach(() => {
  observers.length = 0;
  // @ts-expect-error — overriding global for tests
  globalThis.IntersectionObserver = MockIntersectionObserver;
});

afterEach(() => {
  observers.length = 0;
});

/** Tiny test harness — mounts the hook and renders the sentinel. */
const Harness = (props: {
  readonly hasMore: boolean;
  readonly isLoading: boolean;
  readonly onLoadMore: () => void;
  readonly rootMargin?: string;
}) => {
  const ref = useInfiniteScroll(props);
  return <div data-testid="sentinel" ref={ref} />;
};

/** Drive the latest observer's callback as if the sentinel intersected. */
const fireIntersection = (isIntersecting: boolean) => {
  const handle = observers[observers.length - 1];
  if (!handle) throw new Error('No observer registered');
  handle.callback(
    [
      {
        isIntersecting,
        target: document.createElement('div'),
        boundingClientRect: {} as DOMRectReadOnly,
        intersectionRatio: isIntersecting ? 1 : 0,
        intersectionRect: {} as DOMRectReadOnly,
        rootBounds: null,
        time: 0
      }
    ],
    {} as IntersectionObserver
  );
};

describe('useInfiniteScroll', () => {
  it('observes the sentinel when hasMore is true', () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore isLoading={false} onLoadMore={onLoadMore} />);
    expect(observers).toHaveLength(1);
    expect(observers[0].observe).toHaveBeenCalledTimes(1);
  });

  it('does not observe when hasMore is false', () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore={false} isLoading={false} onLoadMore={onLoadMore} />);
    expect(observers).toHaveLength(0);
  });

  it('fires onLoadMore when the sentinel intersects', () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore isLoading={false} onLoadMore={onLoadMore} />);
    fireIntersection(true);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('does not fire onLoadMore when the sentinel leaves the viewport', () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore isLoading={false} onLoadMore={onLoadMore} />);
    fireIntersection(false);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('does not fire onLoadMore while a load is already in flight', () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore isLoading={true} onLoadMore={onLoadMore} />);
    fireIntersection(true);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('does not fire onLoadMore once hasMore flips false', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <Harness hasMore isLoading={false} onLoadMore={onLoadMore} />
    );
    rerender(<Harness hasMore={false} isLoading={false} onLoadMore={onLoadMore} />);
    // After the rerender, the previous observer is disconnected and no
    // new one is created (because hasMore is false). Nothing should fire.
    expect(observers[0].disconnect).toHaveBeenCalled();
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('passes rootMargin through to the IntersectionObserver', () => {
    render(
      <Harness
        hasMore
        isLoading={false}
        onLoadMore={() => {}}
        rootMargin="500px"
      />
    );
    expect(observers[0].options?.rootMargin).toBe('500px');
  });

  it('defaults rootMargin to 240px when not provided', () => {
    render(<Harness hasMore isLoading={false} onLoadMore={() => {}} />);
    expect(observers[0].options?.rootMargin).toBe('240px');
  });

  it('rebinds the observer when onLoadMore identity changes', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <Harness hasMore isLoading={false} onLoadMore={first} />
    );
    rerender(<Harness hasMore isLoading={false} onLoadMore={second} />);
    expect(observers).toHaveLength(2);
    expect(observers[0].disconnect).toHaveBeenCalled();
    fireIntersection(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = render(
      <Harness hasMore isLoading={false} onLoadMore={() => {}} />
    );
    unmount();
    expect(observers[0].disconnect).toHaveBeenCalled();
  });
});
