import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Box,
  Alert,
  CircularProgress,
  IconButton,
  InputAdornment,
} from '@mui/material';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import RefreshIcon from '@mui/icons-material/Refresh';
import LockIcon from '@mui/icons-material/Lock';
import {
  fetchCloudBackupFromRelays,
  decryptCloudBackup,
  clearCloudRestoreKeyFromUrl,
  CloudBackupEnvelope,
} from '../services/cloudBackup';

export interface CloudRestoreDialogProps {
  open: boolean;
  restoreKey: string | null;
  onClose: () => void;
  onRestoreReady: (decryptedJson: string) => void;
}

export const CloudRestoreDialog: React.FC<CloudRestoreDialogProps> = ({
  open,
  restoreKey,
  onClose,
  onRestoreReady,
}) => {
  const [step, setStep] = useState<'fetching' | 'password' | 'error'>('fetching');
  const [envelope, setEnvelope] = useState<CloudBackupEnvelope | null>(null);
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState<boolean>(false);

  const fetchBackup = async (key: string, retries = 2) => {
    setStep('fetching');
    setError(null);
    try {
      const env = await fetchCloudBackupFromRelays(key, 5000);
      setEnvelope(env);
      setStep('password');
    } catch (err: any) {
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, 1200));
        return fetchBackup(key, retries - 1);
      }
      setError(
        err?.message ||
          'Could not retrieve backup from Nostr relays. The backup may have expired or relays are unreachable.'
      );
      setStep('error');
    }
  };

  useEffect(() => {
    if (open && restoreKey) {
      setPassword('');
      setShowPassword(false);
      setError(null);
      fetchBackup(restoreKey);
    } else if (!open) {
      setEnvelope(null);
      setPassword('');
      setError(null);
      setStep('fetching');
    }
  }, [open, restoreKey]);

  const handleDecrypt = async () => {
    if (!password.trim() || !envelope) return;
    setDecrypting(true);
    setError(null);
    try {
      const jsonStr = await decryptCloudBackup(envelope, password);
      clearCloudRestoreKeyFromUrl();
      onRestoreReady(jsonStr);
      onClose();
    } catch (err: any) {
      setError(
        err?.message ||
          'Decryption failed. Please check your password and verify against corruption.'
      );
    } finally {
      setDecrypting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {step === 'fetching' ? (
          <CloudSyncIcon color="primary" />
        ) : (
          <CloudDownloadIcon color="primary" />
        )}
        <Box component="span" sx={{ fontWeight: 800 }}>
          Cloud Profile Restore
        </Box>
      </DialogTitle>

      <DialogContent dividers sx={{ minHeight: 200, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {step === 'fetching' && (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              py: 4,
              gap: 2,
            }}
          >
            <CircularProgress size={48} color="primary" />
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Retrieving encrypted backup from Nostr relays...
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
              Key: {restoreKey}
            </Typography>
          </Box>
        )}

        {step === 'error' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, py: 1 }}>
            <Alert severity="error">{error}</Alert>
            <Typography variant="body2" color="text.secondary">
              We were unable to locate your profile backup on Nostr relays using this key.
              Please check your internet connection or verify the link.
            </Typography>
            {restoreKey && (
              <Typography
                variant="caption"
                sx={{
                  fontFamily: 'monospace',
                  p: 1,
                  bgcolor: 'action.hover',
                  borderRadius: 1,
                  wordBreak: 'break-all',
                }}
              >
                Key: {restoreKey}
              </Typography>
            )}
          </Box>
        )}

        {step === 'password' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, py: 1 }}>
            <Alert severity="success" sx={{ py: 0.5 }}>
              Encrypted profile backup found on Nostr relays!
            </Alert>

            <Typography variant="body2" color="text.secondary">
              Enter the password that was used to encrypt this backup to verify and decrypt your profile.
            </Typography>

            {error && <Alert severity="error">{error}</Alert>}

            <TextField
              label="Encryption Password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && password.trim() && !decrypting) {
                  handleDecrypt();
                }
              }}
              autoFocus
              fullWidth
              disabled={decrypting}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <LockIcon color="action" fontSize="small" />
                    </InputAdornment>
                  ),
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        aria-label="toggle password visibility"
                        onClick={() => setShowPassword((prev) => !prev)}
                        edge="end"
                        size="small"
                      >
                        {showPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
            />
          </Box>
        )}
      </DialogContent>

      <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
        <Button onClick={onClose} variant="outlined" color="inherit" disabled={decrypting}>
          Cancel
        </Button>

        <Box sx={{ display: 'flex', gap: 1 }}>
          {step === 'error' && (
            <Button
              variant="contained"
              color="primary"
              startIcon={<RefreshIcon />}
              onClick={() => restoreKey && fetchBackup(restoreKey, 2)}
            >
              Retry
            </Button>
          )}

          {step === 'password' && (
            <Button
              variant="contained"
              color="primary"
              onClick={handleDecrypt}
              disabled={!password.trim() || decrypting}
              startIcon={decrypting ? <CircularProgress size={16} color="inherit" /> : <LockIcon />}
            >
              {decrypting ? 'Decrypting...' : 'Decrypt & Restore'}
            </Button>
          )}
        </Box>
      </DialogActions>
    </Dialog>
  );
};
