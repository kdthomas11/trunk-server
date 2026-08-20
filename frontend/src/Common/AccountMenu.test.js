/**
 * Tests for the account menu.
 *
 *   CI=true npm test        (from frontend/)
 *
 * This menu is the only way from the front page to the systems list once
 * someone is signed in - the front page itself carries no Systems link, because
 * a signed-out visitor cannot use one. If the item here disappears, a signed-in
 * listener has no route to the calls except typing the URL.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { configureStore } from '@reduxjs/toolkit';
import { Menu } from 'semantic-ui-react';

import AccountMenu from './AccountMenu';

/** A store with the user in a given state. */
const makeStore = (user) => configureStore({
  reducer: { user: (state = user) => state },
  middleware: (getDefault) => getDefault({ serializableCheck: false })
});

// The menu dispatches authenticateUser when the session has not been checked
// yet, so the thunk needs somewhere to send its request.
beforeEach(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false }) })
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

const signedIn = { authenticated: true, hasChecked: true, callsign: 'n0call', plan: 'free' };
const signedOut = { authenticated: false, hasChecked: true, callsign: null, plan: 'free' };
const unchecked = { authenticated: false, hasChecked: false, callsign: null, plan: 'free' };

const renderMenu = (user, props = {}) => render(
  <Provider store={makeStore(user)}>
    <MemoryRouter>
      <Menu><AccountMenu {...props} /></Menu>
    </MemoryRouter>
  </Provider>
);

describe('signed in', () => {

  it('shows the callsign', () => {
    renderMenu(signedIn);

    expect(screen.getByText('n0call')).toBeInTheDocument();
  });

  it('offers a way to the systems list', async () => {
    renderMenu(signedIn);

    await userEvent.click(screen.getByText('n0call'));

    const systems = screen.getByText('Systems');
    expect(systems).toBeInTheDocument();
    // A route in this app, not a link off to another host: a full page load
    // would throw away the call list already in memory.
    expect(systems.closest('a')).toHaveAttribute('href', '/systems');
  });

  it('still offers the profile and a way out', async () => {
    renderMenu(signedIn);

    await userEvent.click(screen.getByText('n0call'));

    expect(screen.getByText('Profile')).toBeInTheDocument();
    expect(screen.getByText('Log out')).toBeInTheDocument();
  });
});

describe('not signed in', () => {

  it('offers the modals when the page provides them', () => {
    renderMenu(signedOut, { onSignIn: jest.fn(), onRegister: jest.fn() });

    expect(screen.getByText('Sign in')).toBeInTheDocument();
    expect(screen.getByText('Register')).toBeInTheDocument();
    // No Systems here - it needs an account, and offering it to a visitor who
    // cannot use it is the thing the front page was cleared of.
    expect(screen.queryByText('Systems')).not.toBeInTheDocument();
  });

  it('falls back to the account site where there is no modal to open', () => {
    renderMenu(signedOut);

    expect(screen.getByText('Sign in').closest('a')).toHaveAttribute(
      'href', expect.stringContaining('/login')
    );
  });

  it('shows nothing at all until the session has been checked', () => {
    const { container } = renderMenu(unchecked);

    // A "Sign in" link that flickers into a callsign on every page load looks
    // broken, so this renders nothing until the answer is known.
    expect(container.querySelector('.item')).toBeNull();
  });
});
