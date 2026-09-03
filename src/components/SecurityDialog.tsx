import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Divider,
  Alert,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  CircularProgress,
  Snackbar,
} from '@mui/material';
import SecurityIcon from '@mui/icons-material/Security';
import KeyIcon from '@mui/icons-material/Key';
import LockIcon from '@mui/icons-material/Lock';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import HubIcon from '@mui/icons-material/Hub';
import RouterIcon from '@mui/icons-material/Router';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import { useChat } from '../context/ChatContext';

interface SecurityDialogProps {
  open: boolean;
  onClose: () => void;
}

export const SecurityDialog: React.FC<SecurityDialogProps> = ({ open, onClose }) => {
  const {
    convId,
    roomSecret,
    activeKeyId,
    activeEpoch,
    isApproved,
    isRekeying,
    channelOwnerName,
    participants,
    connectedPeersCount,
    relayStatuses,
    rekeyConversation,
    rootFingerprint,
    profile,
  } = useChat();

  const [snack, setSnack] = useState<string | null>(null);

  const handleRekey = async () => {
    const success = await rekeyConversation();
    if (success) {
      setSnack('Conversation rekeyed successfully!');
    } else {
      setSnack('Failed to rekey conversation.');
    }
  };

  const approvedCount = participants.filter((p) => p.isApproved).length;

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <SecurityIcon color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            Security & Protocol v2 Diagnostics
          </Typography>
        </DialogTitle>

        <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          {/* Status Overview Alert */}
          {isApproved ? (
            <Alert
              icon={<CheckCircleIcon fontSize="inherit" />}
              severity="success"
              action={
                <Button
                  color="inherit"
                  size="small"
                  variant="outlined"
                  startIcon={isRekeying ? <CircularProgress size={14} color="inherit" /> : <AutorenewIcon />}
                  onClick={handleRekey}
                  disabled={isRekeying}
                >
                  Rotate Key
                </Button>
              }
            >
              <strong>Channel Secure (Epoch #{activeEpoch})</strong> — {approvedCount} approved participant(s) with active key.
            </Alert>
          ) : (
            <Alert icon={<WarningAmberIcon fontSize="inherit" />} severity="warning">
              <strong>Pending Authorization</strong> — You are connected to the room but have not received an active Epoch key from an approved member.
            </Alert>
          )}

          {/* Cryptographic Architecture Summary */}
          <Box>
            <Typography variant="subtitle2" color="primary" sx={{ fontWeight: 600, mb: 1 }}>
              CRYPTOGRAPHIC IDENTITY & SPECIFICATION
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                gap: 1.5,
                p: 2,
                bgcolor: 'action.hover',
                borderRadius: 2,
              }}
            >
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Transport Mesh:
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <HubIcon fontSize="inherit" color="primary" /> WebRTC Data Channels (Trystero)
                </Typography>
              </Box>

              <Box>
                <Typography variant="caption" color="text.secondary">
                  Signaling Strategy:
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <RouterIcon fontSize="inherit" color="primary" /> Public Nostr Relays (P2P Discovery)
                </Typography>
              </Box>

              <Box>
                <Typography variant="caption" color="text.secondary">
                  Key Derivation (Root Key):
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  HKDF-SHA-256 (from Room Secret)
                </Typography>
              </Box>

              <Box>
                <Typography variant="caption" color="text.secondary">
                  Active Message Encryption:
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  AES-256-GCM (Epoch #{activeEpoch})
                </Typography>
              </Box>

              <Box>
                <Typography variant="caption" color="text.secondary">
                  Digital Signatures:
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  ECDSA P-256 / SHA-256
                </Typography>
              </Box>

              <Box>
                <Typography variant="caption" color="text.secondary">
                  Key Encapsulation (Rekeying):
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  RSA-OAEP 2048-bit / SHA-256
                </Typography>
              </Box>

              <Box sx={{ gridColumn: { xs: '1', sm: '1 / span 2' } }}>
                <Typography variant="caption" color="text.secondary">
                  Your Participant ID:
                </Typography>
                <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.75rem', wordBreak: 'break-all' }}>
                  {profile?.participantId || 'N/A'}
                </Typography>
              </Box>
            </Box>
          </Box>

          <Divider />

          {/* Nostr Relay Statuses */}
          <Box>
            <Typography variant="subtitle2" color="primary" sx={{ fontWeight: 600, mb: 1 }}>
              NOSTR SIGNALING RELAYS ({relayStatuses.length})
            </Typography>
            <List dense sx={{ bgcolor: 'background.paper', borderRadius: 2, border: '1px solid', borderColor: 'divider', maxHeight: 160, overflowY: 'auto' }}>
              {relayStatuses.length === 0 ? (
                <ListItem>
                  <ListItemText secondary="Connecting to Nostr signaling relays..." />
                </ListItem>
              ) : (
                relayStatuses.map((r) => (
                  <ListItem key={r.url} secondaryAction={
                    <Chip
                      size="small"
                      label={r.status.toUpperCase()}
                      color={r.status === 'connected' ? 'success' : r.status === 'connecting' ? 'warning' : 'default'}
                      variant="outlined"
                      sx={{ fontSize: '0.65rem', height: 20 }}
                    />
                  }>
                    <ListItemText
                      primary={r.url}
                      primaryTypographyProps={{ fontFamily: 'monospace', fontSize: '0.75rem' }}
                    />
                  </ListItem>
                ))
              )}
            </List>
          </Box>

          {/* Participants & Epoch Membership Accordion */}
          <Accordion variant="outlined" defaultExpanded>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                Participants & Access Control ({participants.length})
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <List dense>
                {participants.map((p) => (
                  <ListItem key={p.participantId} divider>
                    <ListItemIcon>
                      <FingerprintIcon color={p.isApproved ? 'primary' : 'disabled'} />
                    </ListItemIcon>
                    <ListItemText
                      primary={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {p.screenName} {p.isSelf && '(You)'}
                          </Typography>
                          <Chip
                            size="small"
                            label={p.isApproved ? 'Approved Member' : 'Pending Approval'}
                            color={p.isApproved ? 'success' : 'warning'}
                            variant="outlined"
                            sx={{ height: 18, fontSize: '0.62rem' }}
                          />
                        </Box>
                      }
                      secondary={
                        <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.7rem' }}>
                          ID: {p.participantId.substring(0, 16)}... | Status: {p.status}
                        </Typography>
                      }
                    />
                  </ListItem>
                ))}
              </List>
            </AccordionDetails>
          </Accordion>
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 1.5 }}>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(snack)}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSnack(null)} severity="info" sx={{ width: '100%' }}>
          {snack}
        </Alert>
      </Snackbar>
    </>
  );
};
