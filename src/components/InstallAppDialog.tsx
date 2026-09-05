import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Alert,
} from '@mui/material';
import InstallMobileIcon from '@mui/icons-material/InstallMobile';
import IosShareIcon from '@mui/icons-material/IosShare';
import AddBoxOutlinedIcon from '@mui/icons-material/AddBoxOutlined';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { promptInstall, usePwaStatus } from '../services/pwa';

interface InstallAppDialogProps {
  open: boolean;
  onClose: () => void;
}

const Step: React.FC<{ icon: React.ReactNode; children: React.ReactNode }> = ({ icon, children }) => (
  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.2, py: 0.6 }}>
    <Box sx={{ display: 'flex', color: 'primary.main' }}>{icon}</Box>
    <Typography variant="body2">{children}</Typography>
  </Box>
);

export const InstallAppDialog: React.FC<InstallAppDialogProps> = ({ open, onClose }) => {
  const { canPrompt, standalone, isIos } = usePwaStatus();

  const handleInstall = async () => {
    await promptInstall();
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontWeight: 800 }}>
        <InstallMobileIcon color="primary" />
        Install AirComic
      </DialogTitle>

      <DialogContent>
        {standalone ? (
          <Alert severity="success" icon={<CheckCircleIcon fontSize="inherit" />}>
            AirComic is already installed and running as an app.
          </Alert>
        ) : (
          <>
            <Typography variant="body2" sx={{ mb: 2, color: 'text.secondary' }}>
              Install AirComic to launch it from your home screen in its own window, without the
              browser address bar.
            </Typography>

            {isIos ? (
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
                  In Safari
                </Typography>
                <Step icon={<IosShareIcon fontSize="small" />}>Tap the Share button.</Step>
                <Step icon={<AddBoxOutlinedIcon fontSize="small" />}>
                  Choose <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.
                </Step>
              </Box>
            ) : canPrompt ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                Your browser can install it directly.
              </Typography>
            ) : (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                Your browser has not offered an install prompt. Look for an install or{' '}
                <em>Add to Home screen</em> option in its menu. Installing requires the app to be
                served over HTTPS.
              </Typography>
            )}
          </>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {!standalone && canPrompt && (
          <Button variant="contained" onClick={handleInstall} startIcon={<InstallMobileIcon />}>
            Install
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};
