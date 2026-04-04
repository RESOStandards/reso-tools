import { useCallback, useRef, useState } from 'react';

interface MediaCarouselProps {
  /** Array of media records (expanded from $expand=Media). */
  readonly media: ReadonlyArray<Record<string, unknown>>;
  /** Compact mode for summary cards (single thumbnail). */
  readonly compact?: boolean;
}

const PLACEHOLDER_COUNT = 8;
const LOADING_DELAY_MS = 50;

/** Gets the image URL from a media record, falling back to a placeholder. */
const getImageUrl = (record: Record<string, unknown>, index: number): string => {
  if (typeof record.MediaURL === 'string' && record.MediaURL.length > 0) {
    return record.MediaURL;
  }
  return `/images/placeholder-${(index % PLACEHOLDER_COUNT) + 1}.svg`;
};

/** Image carousel for Media records. Compact mode shows a single thumbnail with count. */
export const MediaCarousel = ({ media, compact = false }: MediaCarouselProps) => {
  const [current, setCurrent] = useState(0);
  const [showSpinner, setShowSpinner] = useState(false);
  const [imageBroken, setImageBroken] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };

  const handleImageLoad = useCallback(() => {
    clearTimer();
    setShowSpinner(false);
  }, []);

  const handleImageError = useCallback(() => {
    clearTimer();
    setShowSpinner(false);
    setImageBroken(true);
  }, []);

  // Reset broken state when navigating to a different image
  const prevCurrentRef = useRef(current);
  if (prevCurrentRef.current !== current) {
    prevCurrentRef.current = current;
    if (imageBroken) setImageBroken(false);
  }

  /** Ref callback for img elements — starts the loading timer and checks if already cached. */
  const imgRef = useCallback((el: HTMLImageElement | null) => {
    clearTimer();
    if (!el) return;
    if (el.complete && el.naturalWidth > 0) {
      setShowSpinner(false);
    } else if (el.complete) {
      setShowSpinner(false);
      setImageBroken(true);
    } else {
      timerRef.current = setTimeout(() => setShowSpinner(true), LOADING_DELAY_MS);
    }
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  if (media.length === 0) return null;

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrent(prev => (prev > 0 ? prev - 1 : media.length - 1));
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrent(prev => (prev < media.length - 1 ? prev + 1 : 0));
  };

  if (compact) {
    return (
      <div className="group relative w-full h-32 sm:h-40 rounded overflow-hidden bg-gray-100">
        {showSpinner && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100 dark:bg-gray-800 z-10">
            <svg className="w-5 h-5 animate-spin text-gray-400" viewBox="0 0 24 24" fill="none">
              <title>Loading image</title>
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}
        {imageBroken ? (
          <div className="w-full h-full flex flex-col items-center justify-center bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500">
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <title>Image unavailable</title>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
            </svg>
            <span className="text-xs mt-1">Image unavailable</span>
          </div>
        ) : (
          <img ref={imgRef} src={getImageUrl(media[current], current)} alt={`Media ${current + 1} of ${media.length}`} className="w-full h-full object-cover" onLoad={handleImageLoad} onError={handleImageError} />
        )}
        {media.length > 1 && (
          <>
            <button
              type="button"
              onClick={handlePrev}
              className="absolute left-1 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-xs"
              aria-label="Previous image">
              &larr;
            </button>
            <button
              type="button"
              onClick={handleNext}
              className="absolute right-1 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-xs"
              aria-label="Next image">
              &rarr;
            </button>
            <span className="absolute bottom-1 right-1 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">
              {current + 1}/{media.length}
            </span>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="relative w-full">
      <div className="relative h-48 sm:h-64 md:h-80 rounded-lg overflow-hidden bg-gray-100">
        {showSpinner && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100 dark:bg-gray-800 z-10">
            <svg className="w-6 h-6 animate-spin text-gray-400" viewBox="0 0 24 24" fill="none">
              <title>Loading image</title>
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}
        {imageBroken ? (
          <div className="w-full h-full flex flex-col items-center justify-center bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500">
            <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <title>Image unavailable</title>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
            </svg>
            <span className="text-sm mt-2">Image unavailable</span>
          </div>
        ) : (
          <img
            ref={imgRef}
            src={getImageUrl(media[current], current)}
            alt={`Media ${current + 1} of ${media.length}`}
            className="w-full h-full object-cover"
            onLoad={handleImageLoad}
            onError={handleImageError}
          />
        )}

        {/* Previous button */}
        {media.length > 1 && (
          <button
            type="button"
            onClick={handlePrev}
            className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white rounded-full w-8 h-8 flex items-center justify-center"
            aria-label="Previous image">
            &larr;
          </button>
        )}

        {/* Next button */}
        {media.length > 1 && (
          <button
            type="button"
            onClick={handleNext}
            className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white rounded-full w-8 h-8 flex items-center justify-center"
            aria-label="Next image">
            &rarr;
          </button>
        )}

        {/* Counter */}
        <span className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded">
          {current + 1} / {media.length}
        </span>
      </div>

      {/* Dot indicators */}
      {media.length > 1 && media.length <= 12 && (
        <div className="flex justify-center gap-1.5 mt-2">
          {media.map((m, i) => (
            <button
              type="button"
              key={String(m.MediaKey ?? m.MediaObjectID ?? i)}
              onClick={() => setCurrent(i)}
              className={`w-2 h-2 rounded-full ${i === current ? 'bg-blue-600' : 'bg-gray-300'}`}
              aria-label={`Go to image ${i + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
};
