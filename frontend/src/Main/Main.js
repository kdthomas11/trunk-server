import React, { useState, useEffect } from "react";
import { Link } from 'react-router-dom'
import SupportModal from "../Common/SupportModal";
import "./Main.css";
import { createMedia } from "@artsy/fresnel";
import {
  Container,
  Grid,
  Header,
  Icon,
  Menu,
  Segment,
  Sidebar,
  Statistic,
} from 'semantic-ui-react'
import { useGetSiteStatsQuery } from "../features/api/apiSlice";
import { useSelector, useDispatch } from 'react-redux'
import { authenticateUser, selectUser } from "../features/user/userSlice";
import AccountMenu from "../Common/AccountMenu";
import SignInModal from "../Common/SignInModal";
import RegisterModal from "../Common/RegisterModal";

/* Responsive component was removed from Semantic UI. This is discussed here: https://github.com/Semantic-Org/Semantic-UI-React/pull/4008 */

const AppMedia = createMedia({
  breakpoints: {
    mobile: 320,
    tablet: 768,
    computer: 992,
    largeScreen: 1200,
    widescreen: 1920
  }
});

const mediaStyles = AppMedia.createMediaStyle();
const { Media } = AppMedia;

/* eslint-disable react/no-multi-comp */
/* Heads up! HomepageHeading uses inline styling, however it's not the best practice. Use CSS or styled components for
 * such things.
 */
const HomepageHeading = ({ mobile }) => {
  // No sign-in or register buttons here. The top menu carries both, and both of
  // these were dead: the modal they needed is opened from there.
  return (
  <Container text style={{ paddingBottom: '0px' }} >
    <Header
      as='h1'
      content='Your Repeaters, Recorded'
      style={{
        fontSize: mobile ? '2em' : '3.5em',
        color: "#FFF",
        fontWeight: 'normal',
        marginBottom: 0,
        marginTop: mobile ? '1.5em' : '0em',
      }}
    />
    <Header
      as='h2'
      content='Listen back to every transmission on your local Ham Radio repeater systems'
      style={{
        fontSize: mobile ? '1.5em' : '1.7em',
        color: "#FFF",
        fontWeight: 'normal',
        marginTop: mobile ? '0.5em' : '1.5em',
        marginBottom: mobile ? '0.5em' : '0em',
      }}
    />
  </Container>
  );
}

/*
HomepageHeading.propTypes = {
  mobile: PropTypes.bool,
}
*/
/* Heads up!
 * Neither Semantic UI nor Semantic UI React offer a responsive navbar, however, it can be implemented easily.
 * It can be more complicated, but you can create really flexible markup.
 */


/*
General flow:

- componentDidMount(): it will call fetchSystem() this will perform an HTTP request if Systems does not exist, and then add System to Props
*/

const DesktopContainer = (props) => {
  const [fixed, setFixed] = useState(false);


  const { children, onSignIn, onRegister } = props

  return (
    <Media greaterThanOrEqual="tablet">
      <div className="relative">
        <div className="static-gradient blue absolute z-0" >
          <div className="static-gradient-bg absolute z-5"></div>
        </div>
        <Segment
          textAlign='center'
          style={{
            padding: '1em 0em',
            borderBottom: '0px',
            boxShadow: 'none',
            height: '400px'
          }}
          vertical
        >

          <Menu
            fixed={fixed ? 'top' : null}
            inverted={true}
            pointing={false}
            secondary={true}
            size='huge'
            style={{ marginRight: '0px' }}
          >
            <Container>
              <Menu.Item ><Header as='h3' inverted>{process.env.REACT_APP_SITE_NAME}</Header></Menu.Item>
              <Menu.Menu position="right">
                <SupportModal trigger={
                  <Menu.Item link><Icon name='heart' /> Donate</Menu.Item>
                } />
                <AccountMenu onSignIn={onSignIn} onRegister={onRegister} />
              </Menu.Menu>
            </Container>
          </Menu>
          <HomepageHeading />
        </Segment>
      </div>

      {children}
    </Media>
  )
}

/*
DesktopContainer.propTypes = {
  children: PropTypes.node,
}
*/
const MobileContainer = (props) => {

  const [sidebarOpened, setSidebarOpened] = useState(false);

  const handlePusherClick = () => {
    setSidebarOpened(!sidebarOpened)
  }

  const handleToggle = () => setSidebarOpened(!sidebarOpened)


  const { children, onSignIn, onRegister } = props

  return (
    <Media lessThan="tablet">
      <Sidebar.Pushable>
        <Sidebar as={Menu} animation='uncover' inverted vertical visible={sidebarOpened} id="menu-bar">
          <Menu.Item active>
            Home
          </Menu.Item>
          <SupportModal trigger={
            <Menu.Item link><Icon name='heart' /> Donate</Menu.Item>
          } />
          <AccountMenu onSignIn={onSignIn} onRegister={onRegister} />
        </Sidebar>

        <Sidebar.Pusher
          dimmed={sidebarOpened}
          onClick={handlePusherClick}
          style={{ minHeight: '100vh' }}
        >
          <div className='relative'>
            <div className="static-gradient blue absolute z-0">
              <div className="static-gradient-bg absolute"></div>
            </div>
            <Segment
              textAlign='center'
              style={{
                minHeight: 350, padding: '1em 0em',
                borderBottom: '0px',
                boxShadow: 'none',
                height: '300px'
              }}
              vertical
            >

              <Container>

                <Menu inverted secondary size='large'>
                  <Menu.Item onClick={handleToggle}>
                    <Icon name='sidebar' />
                  </Menu.Item>
                  <Menu.Item header>{process.env.REACT_APP_SITE_NAME}</Menu.Item>
                </Menu>
              </Container>
              <HomepageHeading mobile />
            </Segment>
          </div>
          {children}
        </Sidebar.Pusher>
      </Sidebar.Pushable>
    </Media>
  )
}


/*
MobileContainer.propTypes = {
  children: PropTypes.node,
}
*/
const ResponsiveContainer = ({ children, onSignIn, onRegister }) => (
  <div>
    <DesktopContainer onSignIn={onSignIn} onRegister={onRegister}>{children}</DesktopContainer>
    <MobileContainer onSignIn={onSignIn} onRegister={onRegister}>{children}</MobileContainer>
  </div>
)







// ----------------------------------------------------
const Main = (props) => {

  const [signInOpen, setSignInOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const dispatch = useDispatch();
  const user = useSelector(selectUser);

  // Both containers and the hero render at once (Fresnel hides one with CSS),
  // so the modals are owned here and there is exactly one of each.
  useEffect(() => {
    if (!user.hasChecked) {
      dispatch(authenticateUser());
    }
  }, [dispatch, user.hasChecked]);
  const { data: siteStats } = useGetSiteStatsQuery();

  return (
    <>
      <style>{mediaStyles}</style>
      {/* Each modal can hand off to the other, so a visitor who opened the
          wrong one is not sent away to find the right one. */}
      <SignInModal
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        onRegister={() => setRegisterOpen(true)}
      />
      <RegisterModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onSignIn={() => setSignInOpen(true)}
      />
      <ResponsiveContainer
        onSignIn={() => setSignInOpen(true)}
        onRegister={() => setRegisterOpen(true)}
      >
        <div style={{ position: 'relative' }}>
          {/* One row: the counters stacked on the left, the two blurbs stacked
              on the right. borderBottom none because a Semantic vertical
              segment otherwise draws a 1px rule beneath itself. */}
          <Segment style={{ padding: '0em', borderBottom: 'none' }} vertical>
            <Grid columns={2} stackable>
              <Grid.Row textAlign='center'>
                <Grid.Column style={{ paddingBottom: '5em', paddingTop: '2em' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '100%' }}>
                    <Statistic>
                      <Statistic.Value>
                        {siteStats?.activeSystems || 0} <Icon name='volume up' size='small' />
                      </Statistic.Value>
                      <Statistic.Label>Active Systems</Statistic.Label>
                    </Statistic>
                    <Statistic style={{ marginTop: '1.5em' }}>
                      <Statistic.Value>
                        {siteStats?.totalClients || 0} <Icon name='headphones' size='small' />
                      </Statistic.Value>
                      <Statistic.Label>People Listening</Statistic.Label>
                    </Statistic>
                  </div>
                </Grid.Column>
                <Grid.Column style={{ paddingBottom: '5em', paddingTop: '2em' }}>
                  <Header as='h3' style={{ fontSize: '2em' }}>
                    <Icon color='orange' name='list' />All The Transmissions
                  </Header>
                  <p style={{ fontSize: '1.33em' }}>Every transmission, on every repeater is recorded</p>

                  <Header as='h3' style={{ fontSize: '2em', marginTop: '1.5em' }}>
                    <Icon color='orange' name='checked calendar' />
                    Go back in time
                  </Header>
                  <p style={{ fontSize: '1.33em' }}>
                    Missed a transmission? Not a problem, everything is archived!
                  </p>
                </Grid.Column>
              </Grid.Row>
            </Grid>
          </Segment>
          <Segment style={{ padding: '8em 0em' }} vertical>
            <Container text>
              <Header as='h3' style={{ fontSize: '2em' }}>
                Don't just scan, hear it all!
              </Header>
              <p style={{ fontSize: '1.33em' }}>
                Most large cities use trunked radio systems to get the most use out of their assigned radio spectrum. With trunked systems, the transmission are constantly hopping to different frequencies. Using a cheap Software Defined Radio (SDR), it is possible capture all of the transmission on a system.
                Instead of scanning to a single frequency, SDR capturea wide swathes of spectrum, covering all of the frequencies a system could use.
              </p>
            </Container>
          </Segment>
        </div>
        <Segment inverted vertical style={{ padding: '5em 0em' }} id="footer">
          <Container>
            <Grid divided inverted stackable>
              <Grid.Row>
                <Grid.Column width={6}>

                </Grid.Column>
                
                <Grid.Column width={4} textAlign='center' >
                <Link to="/terms" ><Header as='h3' inverted>Terms of Service</Header></Link>
                </Grid.Column>
                <Grid.Column width={6}>


                </Grid.Column>
              </Grid.Row>
            </Grid>
          </Container>
        </Segment>

      </ResponsiveContainer>
    </>);
}


export default Main;
