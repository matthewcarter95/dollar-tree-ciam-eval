// Dollar Tree brand color scheme
export const colors = {
  green: {
    primary: '#007A33',   // DT header green
    dark: '#005826',      // hover/active states
    light: '#E8F5E9',     // backgrounds, tints
    muted: '#4CAF50',
  },
  yellow: {
    primary: '#FFD500',   // DT accent yellow
    light: '#FFFDE7',
    dark: '#F9A825',
  },
  white: '#FFFFFF',
  gray: {
    50: '#FAFAFA',
    100: '#F5F5F5',
    200: '#EEEEEE',
    400: '#BDBDBD',
    600: '#757575',
    800: '#424242',
  },
  text: {
    primary: '#212121',
    secondary: '#616161',
    onGreen: '#FFFFFF',
    onYellow: '#1A1A1A',
  },
};

export type Colors = typeof colors;
