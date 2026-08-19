import { useState } from 'react';
import {
  Modal,
  Button,
  Divider,
  Icon,
  Message
} from "semantic-ui-react";

/**
 * Where the Donate button leads.
 *
 * Both destinations are placeholders until the accounts exist. An empty string
 * renders the button disabled rather than linking somewhere wrong - this modal
 * used to point at the upstream OpenMHz project's GitHub Sponsors and Patreon,
 * which would now be sending this site's supporters to somebody else.
 *
 * Fill these in and the buttons light up; nothing else needs changing.
 */
const BUY_ME_A_COFFEE_URL = "";
const PATREON_URL = "";

function SupportModal(props) {

  const [open, setOpen] = useState(false);
  const siteName = process.env.REACT_APP_SITE_NAME;

  /** A donation link, or a disabled button while the account is being set up. */
  const DonateButton = ({ url, icon, label }) => (
    url
      ? <a href={url}><Button><Icon name={icon} />{label}</Button></a>
      : <Button disabled title="Coming soon"><Icon name={icon} />{label}</Button>
  );

  return (
    <Modal open={open} onClose={() => setOpen(false)} onOpen={() => setOpen(true)} trigger={props.trigger} size='tiny' >
      <Modal.Header>Support {siteName}</Modal.Header>
      <Modal.Content image>
        <Icon size='massive' name="coffee" />
        <Modal.Description>
          <p>If {siteName} brings you joy, think about becoming a supporter! It will cover hosting costs.</p>

          <Message info>
            <Message.Header>Supporters get transcription and search</Message.Header>
            <p>
              Every transmission is transcribed, and the archive becomes
              searchable by what was actually said - so you can find the
              transmission you are after without listening through the whole day.
            </p>
          </Message>

          <Divider horizontal>Donate</Divider>
          <DonateButton url={BUY_ME_A_COFFEE_URL} icon="coffee" label="Buy Me A Coffee" />
          {' '}
          <DonateButton url={PATREON_URL} icon="patreon" label="Patreon" />

        </Modal.Description>

      </Modal.Content>
      <Modal.Actions>
        <Button onClick={() => setOpen(false)} >
          Done
        </Button>
      </Modal.Actions>
    </Modal>

  )

}

export default SupportModal;
