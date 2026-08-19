import { useState } from "react";
import {
  Modal,
  Form,
  Button,
  Message,
  Icon,
  Divider
} from "semantic-ui-react";

/**
 * Creating an account without leaving the front page.
 *
 * The counterpart to SignInModal. The account service is still the only thing
 * that creates accounts; this posts to the same /register endpoint the account
 * site's own form uses, so the validation, the duplicate checks and the
 * confirmation email are all unchanged.
 *
 * Registration does not sign anyone in - the address has to be confirmed first
 * - so a success here ends in "check your email" rather than a redirect.
 */
const RegisterModal = ({ open, onClose, onSignIn }) => {
  const accountServer = process.env.REACT_APP_ACCOUNT_SERVER;

  const blank = {
    firstName: "",
    lastName: "",
    callsign: "",
    email: "",
    password: "",
    city: "",
    state: "",
    country: ""
  };

  const [fields, setFields] = useState(blank);
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = (name) => (e, { value }) => setFields((f) => ({ ...f, [name]: value }));

  const close = () => {
    setFields(blank);
    setMessage("");
    setDone(false);
    setBusy(false);
    onClose();
  };

  const submit = async () => {
    // The server validates all of this again and is the authority. Checking
    // here too just saves a round trip and points at the field that is wrong.
    if (!fields.firstName || fields.firstName.length < 2) return setMessage("First name is required.");
    if (!fields.lastName || fields.lastName.length < 2) return setMessage("Last name is required.");
    if (!/^[a-zA-Z0-9]{3,7}$/.test(fields.callsign.trim())) {
      return setMessage("Callsign must be 3 to 7 letters and numbers, with no spaces or punctuation.");
    }
    if (!fields.email) return setMessage("Email address is required.");
    if (!fields.password) return setMessage("Password is required.");
    if (!fields.city || fields.city.length < 2) return setMessage("City is required.");
    if (!fields.country || fields.country.length < 2) return setMessage("Country is required.");

    setBusy(true);
    setMessage("");

    let result;
    try {
      const res = await fetch(`${accountServer}/register`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields)
      });
      result = await res.json();
    } catch (err) {
      setBusy(false);
      setMessage("Could not reach the account service. Please try again.");
      return;
    }
    setBusy(false);

    // A duplicate email or callsign comes back as a 500 with success:false,
    // while a validation failure is a 200 with success:false. Both carry the
    // message worth showing, so neither is treated as a transport error.
    if (!result.success) {
      setMessage(result.message || "Could not create that account.");
      return;
    }
    setDone(true);
  };

  return (
    <Modal open={open} onClose={close} size="small" closeIcon>
      <Modal.Header>Create a {process.env.REACT_APP_SITE_NAME} account</Modal.Header>
      <Modal.Content>
        {done ? (
          <Message positive icon>
            <Icon name="mail" />
            <Message.Content>
              <Message.Header>Check your email</Message.Header>
              We have sent a confirmation link to {fields.email}. Follow it to
              finish setting up your account, then sign in.
            </Message.Content>
          </Message>
        ) : (
          <Form onSubmit={submit}>
            <Form.Group widths="equal">
              <Form.Input
                label="First name"
                name="firstName"
                autoComplete="given-name"
                value={fields.firstName}
                onChange={set("firstName")}
              />
              <Form.Input
                label="Last name"
                name="lastName"
                autoComplete="family-name"
                value={fields.lastName}
                onChange={set("lastName")}
              />
            </Form.Group>

            <Form.Group widths="equal">
              <Form.Input
                label="Callsign"
                name="callsign"
                // Shown uppercase because that is the convention everywhere
                // else; it is stored lowercase either way.
                style={{ textTransform: "uppercase" }}
                value={fields.callsign}
                onChange={set("callsign")}
              />
              <Form.Input
                icon="user"
                iconPosition="left"
                label="Email"
                type="email"
                name="email"
                autoComplete="email"
                value={fields.email}
                onChange={set("email")}
              />
            </Form.Group>

            <Form.Input
              icon="lock"
              iconPosition="left"
              label="Password"
              type="password"
              name="password"
              autoComplete="new-password"
              value={fields.password}
              onChange={set("password")}
            />

            <Form.Group widths="equal">
              <Form.Input
                label="City"
                name="city"
                autoComplete="address-level2"
                value={fields.city}
                onChange={set("city")}
              />
              <Form.Input
                label="State or region"
                name="state"
                autoComplete="address-level1"
                placeholder="Optional"
                value={fields.state}
                onChange={set("state")}
              />
              <Form.Input
                label="Country"
                name="country"
                autoComplete="country-name"
                value={fields.country}
                onChange={set("country")}
              />
            </Form.Group>

            {message &&
              <Message negative>
                <Icon name="exclamation circle" />
                {message}
              </Message>}

            {/* Submits the form, so Enter works from any field. */}
            <Button primary fluid size="large" type="submit" loading={busy} disabled={busy}>
              Create account
            </Button>
          </Form>
        )}

        {!done && onSignIn &&
          <>
            <Divider horizontal>Or</Divider>
            <Button
              fluid
              size="large"
              content="Sign in to an existing account"
              onClick={() => { close(); onSignIn(); }}
            />
          </>}
      </Modal.Content>
    </Modal>
  );
};

export default RegisterModal;
