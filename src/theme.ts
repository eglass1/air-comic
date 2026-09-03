import { createTheme } from '@mui/material/styles';

export const createAppTheme = (mode: 'dark' | 'light') =>
  createTheme({
    palette: {
      mode,
      primary: {
        main: mode === 'dark' ? '#00e5ff' : '#0070f3',
        light: '#6ff9ff',
        dark: '#00b2cc',
        contrastText: mode === 'dark' ? '#000000' : '#ffffff',
      },
      secondary: {
        main: mode === 'dark' ? '#b388ff' : '#7928ca',
        light: '#e7b9ff',
        dark: '#805acb',
        contrastText: '#ffffff',
      },
      success: {
        main: '#00e676',
        light: '#66ffa6',
        dark: '#00b248',
      },
      warning: {
        main: '#ffab00',
      },
      error: {
        main: '#ff5252',
      },
      background: {
        default: mode === 'dark' ? '#0d1117' : '#f6f8fa',
        paper: mode === 'dark' ? '#161b22' : '#ffffff',
      },
      text: {
        primary: mode === 'dark' ? '#f0f6fc' : '#1f2328',
        secondary: mode === 'dark' ? '#8b949e' : '#656d76',
      },
      divider: mode === 'dark' ? 'rgba(240, 246, 252, 0.12)' : 'rgba(31, 35, 40, 0.12)',
    },
    typography: {
      fontFamily: [
        'Roboto',
        '-apple-system',
        'BlinkMacSystemFont',
        '"Segoe UI"',
        'Helvetica',
        'Arial',
        'sans-serif',
      ].join(','),
      button: {
        textTransform: 'none',
        fontWeight: 600,
      },
    },
    shape: {
      borderRadius: 10,
    },
    components: {
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: 8,
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            fontWeight: 500,
          },
        },
      },
    },
  });
