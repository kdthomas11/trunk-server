import { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Link } from "react-router-dom";
import { Menu, Dropdown, Modal, Button, Icon } from "semantic-ui-react";

import { authenticateUser, logoutUser, selectUser } from "../features/user/userSlice";

/**
 * The signed-in listener, and how to stop being one.
 *
 * Sits in the top menu on the systems list and the player. Callsigns are stored
 * lowercase and shown uppercase, which is the convention everywhere else in the
 * UI.
 */
const AccountMenu = ({ onSignIn, onRegister }) => {
  const dispatch = useDispatch();
  const user = useSelector(selectUser);
  const [confirming, setConfirming] = useState(false);
  const accountServer = process.env.REACT_APP_ACCOUNT_SERVER;

  useEffect(() => {
    if (!user.hasChecked) {
      dispatch(authenticateUser());
    }
  }, [dispatch, user.hasChecked]);

  const signOut = async () => {
    setConfirming(false);
    await dispatch(logoutUser());
    // Back to the front page rather than staying on a page that is about to
    // start answering 401. A full navigation also clears the cached call list,
    // which belonged to the session that just ended.
    window.location = "/";
  };

  // Nothing to show until we know - a "Sign in" link that flickers into a
  // callsign on every page load looks broken.
  if (!user.hasChecked) {
    return null;
  }

  if (!user.authenticated) {
    // On the front page these open modals, so a visitor signs in or registers
    // without being sent to another hostname. Elsewhere there is no modal to
    // open and the account site handles it.
    if (onSignIn) {
      return (
        <>
          <Menu.Item link onClick={onSignIn}>
            <Icon name="sign in" /> Sign in
          </Menu.Item>
          <Menu.Item
            link
            {...(onRegister
              ? { onClick: onRegister }
              : { href: `${accountServer}/register` })}
          >
            Register
          </Menu.Item>
        </>
      );
    }
    return (
      <Menu.Item link href={`${accountServer}/login?nextLocation=frontend`}>
        <Icon name="sign in" /> Sign in
      </Menu.Item>
    );
  }

  return (
    <>
      <Dropdown item icon={null} trigger={
        <span><Icon name="user circle" />{user.callsign || "Account"}</span>
      }>
        <Dropdown.Menu>
          {/* The front page carries no Systems link - it is a page a signed-out
              visitor cannot use - so once someone is signed in this menu is the
              only way from there to the systems list. A Link rather than an
              href: it is a route in this app, and a full page load would throw
              away the loaded call list. */}
          <Dropdown.Item as={Link} to="/systems" icon="list" text="Systems" />
          <Dropdown.Item icon="id card" text="Profile" href={`${accountServer}/profile`} />
          <Dropdown.Item icon="sign out" text="Log out" onClick={() => setConfirming(true)} />
        </Dropdown.Menu>
      </Dropdown>

      <Modal open={confirming} size="tiny" onClose={() => setConfirming(false)}>
        <Modal.Header>Log out?</Modal.Header>
        <Modal.Content>
          <p>
            You will need to sign in again to reach the systems list and listen
            to calls.
          </p>
        </Modal.Content>
        <Modal.Actions>
          <Button onClick={() => setConfirming(false)}>Stay signed in</Button>
          <Button primary onClick={signOut}>Log out</Button>
        </Modal.Actions>
      </Modal>
    </>
  );
};

export default AccountMenu;
