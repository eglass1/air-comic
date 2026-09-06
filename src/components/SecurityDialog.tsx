import React, { useState, useEffect } from 'react';
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
  IconButton,
  Tooltip,
  TextField,
  FormControlLabel,
  Switch,
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
    participants,
    connectedPeersCount,
    accelerationStatus,
    relayStatuses,
    refreshRelays,
    reconnectRelays,
    rekeyConversation,
    roomFingerprint,
    memberCount,
    capabilityGeneration,
    relayUrls,
    setRelayUrls,
    webrtcEnabled,
    setWebrtcEnabled,
    profile,
  } = useChat();

  const [snack, setSnack] = useState<string | null>(null);
  const [isReconnectingRelays, setIsReconnectingRelays] = useState(false);
  const [relayDraft, setRelayDraft] = useState('');

  useEffect(() => {
    if (open) setRelayDraft(relayUrls.join('\n'));
  }, [open, relayUrls]);

  useEffect(() => {
    if (open) {
      refreshRelays();
    }
  }, [open, refreshRelays]);

  const handleReconnectRelays = async () => {
    setIsReconnectingRelays(true);
    try {
      await reconnectRelays();
      setSnack('Reconnected to Nostr signaling relays.');
    } catch {
      setSnack('Failed to reconnect to relays.');
    } finally {
      setIsReconnectingRelays(false);
    }
  };

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
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="subtitle2" color="primary" sx={{ fontWeight: 600 }}>
                NOSTR RELAYS ({relayStatuses.filter((r) => r.connected).length}/{relayStatuses.length} CONNECTED)
              </Typography>
              <Tooltip title="Reconnect signaling relays">
                <span>
                  <IconButton
                    size="small"
                    onClick={handleReconnectRelays}
                    disabled={isReconnectingRelays}
                    color="primary"
                  >
                    <AutorenewIcon
                      fontSize="small"
                      sx={{
                        animation: isReconnectingRelays ? 'spin 1s linear infinite' : 'none',
                        '@keyframes spin': {
                          '0%': { transform: 'rotate(0deg)' },
                          '100%': { transform: 'rotate(360deg)' },
                        },
                      }}
                    />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
            <List dense sx={{ bgcolor: 'background.paper', borderRadius: 2, border: '1px solid', borderColor: 'divider', maxHeight: 160, overflowY: 'auto' }}>
              {relayStatuses.length === 0 ? (
                <ListItem>
                  <ListItemText secondary="Connecting to Nostr relays..." />
                </ListItem>
              ) : (
                relayStatuses.map((r) => (
                  <ListItem key={r.url} secondaryAction={
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      {/* Connected, writable and readable are distinct facts
                          about a relay and are reported separately [A-01]. */}
                      <Chip
                        size="small"
                        label={r.connected ? 'CONN' : 'DOWN'}
                        color={r.connected ? 'success' : 'default'}
                        variant="outlined"
                        sx={{ fontSize: '0.6rem', height: 20 }}
                      />
                      <Chip
                        size="small"
                        label="W"
                        title="Writable: a recent event was accepted"
                        color={r.writable ? 'success' : 'default'}
                        variant="outlined"
                        sx={{ fontSize: '0.6rem', height: 20 }}
                      />
                      <Chip
                        size="small"
                        label="R"
                        title="Readable: a subscription has produced events"
                        color={r.readable ? 'success' : 'default'}
                        variant="outlined"
                        sx={{ fontSize: '0.6rem', height: 20 }}
                      />
                    </Box>
                  }>
                    <ListItemText
                      primary={r.url}
                      secondary={r.lastError || undefined}
                      primaryTypographyProps={{ fontFamily: 'monospace', fontSize: '0.75rem' }}
                      secondaryTypographyProps={{ fontSize: '0.65rem' }}
                    />
                  </ListItem>
                ))
              )}
            </List>

            {/* The relay list must be user-configurable [T-01][U-03]. */}
            <Accordion disableGutters sx={{ mt: 1, bgcolor: 'transparent' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="caption" sx={{ fontWeight: 700 }}>
                  EDIT RELAY LIST
                </Typography>
              </AccordionSummary>
              <AccordionDetails>
                <TextField
                  multiline
                  minRows={4}
                  fullWidth
                  value={relayDraft}
                  onChange={(e) => setRelayDraft(e.target.value)}
                  placeholder={'wss://relay.example\nwss://another.example'}
                  helperText="One wss:// URL per line. Leaving this empty restores the defaults."
                  InputProps={{ sx: { fontFamily: 'monospace', fontSize: '0.75rem' } }}
                />
                <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                  <Button
                    size="small"
                    variant="contained"
                    onClick={async () => {
                      await setRelayUrls(relayDraft.split('\n'));
                      setSnack('Relay list saved.');
                    }}
                  >
                    Save relays
                  </Button>
                  <Button size="small" onClick={() => setRelayDraft(relayUrls.join('\n'))}>
                    Reset
                  </Button>
                </Box>
                <FormControlLabel
                  sx={{ mt: 1 }}
                  control={
                    <Switch
                      checked={webrtcEnabled}
                      onChange={(e) => void setWebrtcEnabled(e.target.checked)}
                      size="small"
                    />
                  }
                  label={
                    <Typography variant="caption">
                      Use direct peer connections when possible (an optimisation only --
                      rooms work over relays either way)
                    </Typography>
                  }
                />
              </AccordionDetails>
            </Accordion>
          </Box>

          <Divider />

          {/* Say plainly what is and is not protected [R-07]. */}
          <Box>
            <Typography variant="subtitle2" color="primary" sx={{ fontWeight: 600, mb: 1 }}>
              WHAT THIS PROTECTS
            </Typography>
            <Alert severity="info" sx={{ py: 0.5, mb: 1 }}>
              <Typography variant="caption" component="div">
                <strong>Content.</strong> Private room messages are end-to-end encrypted; only
                current members hold the key. Public room messages are not encrypted at all.
              </Typography>
            </Alert>
            <Alert severity="warning" sx={{ py: 0.5, mb: 1 }}>
              <Typography variant="caption" component="div">
                <strong>Not metadata.</strong> Relays can see your IP address, when you are
                active, how much you send, and which room pseudonym you publish under.
                Direct peer connections reveal your network address to those peers.
              </Typography>
            </Alert>
            <Alert severity="warning" sx={{ py: 0.5 }}>
              <Typography variant="caption" component="div">
                <strong>Not this device.</strong> Your keys, room secrets and message history
                are stored unencrypted in this browser profile, protected only by your
                operating-system account. Anyone with access to it has access to them.
              </Typography>
            </Alert>
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
