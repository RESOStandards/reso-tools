import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest does not wire @testing-library/react's automatic afterEach
// cleanup the way Jest does. Without this, DOM from a previous test
// stays in document.body and screen queries match across tests, which
// produces "found multiple elements" failures in the next test.
afterEach(() => {
  cleanup();
});
