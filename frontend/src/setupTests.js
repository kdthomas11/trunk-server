// Registers the jest-dom matchers - toBeInTheDocument, toBeEmptyDOMElement and
// the rest. create-react-app loads this file automatically before each test
// file; @testing-library/jest-dom was already a devDependency but nothing ever
// imported it, so those matchers were undefined in any test that reached for
// them.
import '@testing-library/jest-dom';
