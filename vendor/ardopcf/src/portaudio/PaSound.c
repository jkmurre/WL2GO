/*
 * PaSound.c -- PortAudio audio backend for ardopcf.
 *
 * Derived from src/linux/ALSASound.c in https://github.com/pflarue/ardop,
 * which carries the copyright and MIT licence reproduced below. The ALSA
 * device/stream layer has been replaced with PortAudio so that one audio
 * implementation serves macOS, Windows and Linux; all surrounding logic is
 * unchanged from upstream.
 *
 * ardopcf is Copyright (c) 2014-2024 Rick Muething, John Wiseman, Peter LaRue
 * and is released under the MIT licence. See the LICENSE file of the upstream
 * project for the full text and for the authors of bundled libraries.
 *
 * Modifications for WL2GO are likewise MIT licensed.
 */

//
// Audio interface Routine

// Passes audio samples to/from the sound intemrface

// As this is platform specific it also has the main() routine, which does
// platform specific initialisation before calling ardopmain()

// This is ALSASound.c for Linux
// Windows Version is Waveout.c

// ALSA is replaced by PortAudio (see the backend section below). Upstream
// relied on <alsa/asoundlib.h> to pull these in transitively.
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <termios.h>
#include <sys/ioctl.h>
#include <stdbool.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#define HANDLE int

#include "common/ardopcommon.h"
#include "common/wav.h"
#include "rockliff/rrs.h"

#define SHARECAPTURE  // if defined capture device is opened and closed for each transission


void gpioSetMode(unsigned gpio, unsigned mode);
void gpioWrite(unsigned gpio, unsigned level);
int WriteLog(char * msg, int Log);
int _memicmp(unsigned char *a, unsigned char *b, int n);
int stricmp(const unsigned char * pStr1, const unsigned char *pStr2);
int gpioInitialise(void);
HANDLE OpenCOMPort(VOID * pPort, int speed, BOOL SetDTR, BOOL SetRTS, BOOL Quiet, int Stopbits);

VOID COMSetDTR(HANDLE fd);
VOID COMClearDTR(HANDLE fd);
VOID COMSetRTS(HANDLE fd);
VOID COMClearRTS(HANDLE fd);
VOID RadioPTT(int PTTState);
VOID SerialHostPoll();
VOID TCPHostPoll();
int CloseSoundCard();
void CloseSound();
int PackSamplesAndSend(short * input, int nSamples);
BOOL WriteCOMBlock(HANDLE fd, char * Block, int BytesToWrite);
VOID processargs(int argc, char * argv[]);
int wg_send_currentlevel(int cnum, unsigned char level);
int wg_send_pttled(int cnum, bool isOn);
int wg_send_pixels(int cnum, unsigned char *data, size_t datalen);
void WebguiPoll();

int add_noise(short *samples, unsigned int nSamples, short stddev);
short InputNoiseStdDev = 0;

extern BOOL blnDISCRepeating;

extern char * CM108Device;

extern int SampleNo;
extern unsigned int pttOnTime;

unsigned long fpp;  // Frames per period.
int dir;

BOOL UseLeftRX = TRUE;
BOOL UseRightRX = TRUE;

BOOL UseLeftTX = TRUE;
BOOL UseRightTX = TRUE;

extern BOOL WriteRxWav;
extern BOOL WriteTxWav;
extern BOOL FixTiming;
extern char DecodeWav[5][256];
extern int WavNow;  // Time since start of WAV file being decoded

extern struct sockaddr HamlibAddr;  // Dest for above
extern int useHamLib;


void Sleep(int mS)
{
	if (strcmp(PlaybackDevice, "NOSOUND") != 0)
		usleep(mS * 1000);
	return;
}


// Windows and ALSA work with signed samples +- 32767
short buffer[2][1200];  // Two Transfer/DMA buffers of 0.1 Sec
short inbuffer[2][1200];  // Two Transfer/DMA buffers of 0.1 Sec

BOOL Loopback = FALSE;
// BOOL Loopback = TRUE;

char CaptureDevice[80] = "ARDOP";
char PlaybackDevice[80] = "ARDOP";

char * CaptureDevices = CaptureDevice;
char * PlaybackDevices = CaptureDevice;

int InitSound();

int Ticks;

int LastNow;

extern int Number;  // Number waiting to be sent

long MaxAvail;

#include <stdarg.h>

struct WavFile *rxwf = NULL;
struct WavFile *txwff = NULL;
// writing unfiltered tx audio to WAV disabled
// struct WavFile *txwfu = NULL;
#define RXWFTAILMS 10000;  // 10 seconds
unsigned int rxwf_EndNow = 0;

void extendRxwf()
{
	rxwf_EndNow = Now + RXWFTAILMS;
}

void StartRxWav()
{
	// Open a new WAV file if not already recording.
	// If already recording, then just extend the time before
	// recording will end.
	//
	// Wav files will use a filename that includes port, UTC date,
	// and UTC time, similar to log files but with added time to
	// the nearest second.  Like Log files, these Wav files will be
	// written to the Log directory if defined, else to the current
	// directory
	//
	// As currently implemented, the wav file written contains only
	// received audio.  Since nothing is written for the time while
	// transmitting, and thus not receiving, this recording is not
	// time continuous.  Thus, the filename indicates the time that
	// the recording was started, but the times of the received
	// transmissions, other than the first one, are not indicated.
	char rxwf_pathname[1024];
	int pnlen;

	if (rxwf != NULL)
	{
		// Already recording, so just extend recording time.
		extendRxwf();
		return;
	}
	struct tm * tm;
	time_t T;

	T = time(NULL);
	tm = gmtime(&T);

	struct timespec tp;
	int ss, hh, mm;
	clock_gettime(CLOCK_REALTIME, &tp);
	ss = tp.tv_sec % 86400;  // Seconds in a day
	hh = ss / 3600;
	mm = (ss - (hh * 3600)) / 60;
	ss = ss % 60;

	if (ardop_log_get_directory()[0])
		pnlen = snprintf(rxwf_pathname, sizeof(rxwf_pathname),
			"%s/ARDOP_rxaudio_%d_%04d%02d%02d_%02d%02d%02d.wav",
			ardop_log_get_directory(), port, tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday,
			hh, mm, ss);
	else
		pnlen = snprintf(rxwf_pathname, sizeof(rxwf_pathname),
			"ARDOP_rxaudio_%d_%04d%02d%02d_%02d:%02d:%02d.wav",
			port, tm->tm_year +1900, tm->tm_mon+1, tm->tm_mday,
			hh, mm, ss);
	if (pnlen == -1 || pnlen > sizeof(rxwf_pathname)) {
		// Logpath too long likely to also prevent writing to log files.
		// So, print this error directly to console instead of using
		// WriteDebugLog.
		printf("Unable to write WAV file, invalid pathname. Logpath may be too long.\n");
		WriteRxWav = FALSE;
		return;
	}
	rxwf = OpenWavW(rxwf_pathname);
	extendRxwf();
}

// writing unfiltered tx audio to WAV disabled.  Only filtered
// tx audio will be written.  However, the code for unfiltered
// audio is left in place but commented out so that it can eaily
// be restored if desired.
void StartTxWav()
{
	// Open two new WAV files for filtered and unfiltered Tx audio.
	//
	// Wav files will use a filename that includes port, UTC date,
	// and UTC time, similar to log files but with added time to
	// the nearest second.  Like Log files, these Wav files will be
	// written to the Log directory if defined, else to the current
	// directory
	char txwff_pathname[1024];
	// char txwfu_pathname[1024];
	int pnflen;
	// int pnulen;

	if (txwff != NULL)  // || txwfu != NULL)
	{
		ZF_LOGW("WARNING: Trying to open Tx WAV file, but already open.");
		return;
	}
	struct tm * tm;
	time_t T;

	T = time(NULL);
	tm = gmtime(&T);

	struct timespec tp;
	int ss, hh, mm;
	clock_gettime(CLOCK_REALTIME, &tp);
	ss = tp.tv_sec % 86400;  // Seconds in a day
	hh = ss / 3600;
	mm = (ss - (hh * 3600)) / 60;
	ss = ss % 60;

	if (ardop_log_get_directory()[0])
	{
		pnflen = snprintf(txwff_pathname, sizeof(txwff_pathname),
			"%s/ARDOP_txfaudio_%d_%04d%02d%02d_%02d%02d%02d.wav",
			ardop_log_get_directory(), port, tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday,
			hh, mm, ss);
	}
	else
	{
		pnflen = snprintf(txwff_pathname, sizeof(txwff_pathname),
			"ARDOP_txfaudio_%d_%04d%02d%02d_%02d:%02d:%02d.wav",
			port, tm->tm_year +1900, tm->tm_mon+1, tm->tm_mday,
			hh, mm, ss);
	}
	if (pnflen == -1 || pnflen > sizeof(txwff_pathname)) {
		// Logpath too long likely to also prevent writing to log files.
		// So, print this error directly to console instead of using
		// WriteDebugLog.
		printf("Unable to write WAV file, invalid pathname. Logpath may be too long.\n");
		WriteTxWav = FALSE;
		return;
	}
	// if (pnulen == -1 || pnulen > sizeof(txwfu_pathname)) {
		// Logpath too long likely to also prevent writing to log files.
		// So, print this error directly to console instead of using
		// WriteDebugLog.
		// printf("Unable to write WAV file, invalid pathname. Logpath may be too long.\n");
		// WriteTxWav = FALSE;
		// return;
	// }
	txwff = OpenWavW(txwff_pathname);
	// txwfu = OpenWavW(txwfu_pathname);
}

void printtick(char * msg)
{
	ZF_LOGI("%s %i", msg, Now - LastNow);
	LastNow = Now;
}

struct timespec time_start;

unsigned int getTicks()
{
	struct timespec tp;

	// When decoding a WAV file, return WavNow, a measure of the offset
	// in ms from the start of the WAV file.
	if (DecodeWav[0][0])
		return WavNow;

	// Otherwise, return a measure of clock time (also measured in ms).
	clock_gettime(CLOCK_MONOTONIC, &tp);
	return (tp.tv_sec - time_start.tv_sec) * 1000 + (tp.tv_nsec - time_start.tv_nsec) / 1000000;
}

void PlatformSleep(int mS)
{
	TCPHostPoll();
	WebguiPoll();

	if (strcmp(PlaybackDevice, "NOSOUND") != 0)
		Sleep(mS);

	if (PKTLEDTimer && Now > PKTLEDTimer)
	{
		PKTLEDTimer = 0;
		SetLED(PKTLED, 0);  // turn off packet rxed led
	}
}

/*
 * Lists common signal abbreviations
 *
 * This method is a portable version of glibc's sigabbrev_np().
 * It only supports a handful of signal names that ARDOP
 * currently catches and/or ignores. Unlike the glibc function,
 * the return value is always guaranteed to be non-NULL.
 */
const char* PlatformSignalAbbreviation(int signal) {
	switch (signal) {
		case SIGABRT:
			return "SIGABRT";
		case SIGINT:
			return "SIGINT";
		case SIGHUP:
			return "SIGHUP";
		case SIGPIPE:
			return "SIGPIPE";
		case SIGTERM:
			return "SIGTERM";
		default:
			return "Unknown";
	}
}

// PTT via GPIO code

#if defined(__ARM_ARCH) && defined(__linux__)

#define PI_INPUT 0
#define PI_OUTPUT 1
#define PI_ALT0 4
#define PI_ALT1 5
#define PI_ALT2 6
#define PI_ALT3 7
#define PI_ALT4 3
#define PI_ALT5 2

// Set GPIO pin as output and set low

extern int pttGPIOPin;
extern BOOL pttGPIOInvert;



void SetupGPIOPTT()
{
	if (pttGPIOPin == -1)
	{
		ZF_LOGI("GPIO PTT disabled");
		RadioControl = FALSE;
		useGPIO = FALSE;
	}
	else
	{
		if (pttGPIOPin < 0) {
			pttGPIOInvert = TRUE;
			pttGPIOPin = -pttGPIOPin;
		}

		gpioSetMode(pttGPIOPin, PI_OUTPUT);
		gpioWrite(pttGPIOPin, pttGPIOInvert ? 1 : 0);
		ZF_LOGI("Using GPIO pin %d for PTT", pttGPIOPin);
		RadioControl = TRUE;
		useGPIO = TRUE;
	}
}
#endif


static void signal_handler_trigger_shutdown(int sig)
{
	blnClosing = TRUE;
	closedByPosixSignal = sig;
}

char * PortString = NULL;


int platform_main(int argc, char * argv[])
{
	struct timespec tp;
	struct sigaction act;
	int lnlen;
	// rslen_set[] must list all of the rslen values used.
	int rslen_set[] = {2, 4, 8, 16, 32, 36, 50, 64};
	init_rs(rslen_set, 8);

	char cmdstr[3000] = "";
	for (int i = 0; i < argc; i++) {
		if ((int)(sizeof(cmdstr) - strlen(cmdstr))
			<= snprintf(
				cmdstr + strlen(cmdstr),
				sizeof(cmdstr) - strlen(cmdstr),
				"%s ",
				argv[i])
		) {
			printf("ERROR: cmdstr[%ld] insufficient to hold fill command string for logging.\n", sizeof(cmdstr));
			break;
		}
	}

//	Sleep(1000);  // Give LinBPQ time to complete init if exec'ed by linbpq

	processargs(argc, argv);

	setlinebuf(stdout);  // So we can redirect output to file and tail

	ZF_LOGI("%s Version %s (https://www.github.com/pflarue/ardop)", ProductName, ProductVersion);
	ZF_LOGI("Copyright (c) 2014-2024 Rick Muething, John Wiseman, Peter LaRue");
	ZF_LOGI(
		"See https://github.com/pflarue/ardop/blob/master/LICENSE for licence details including\n"
		"  information about authors of external libraries used and their licenses."
	);
	ZF_LOGD("Command line: %s", cmdstr);

	if (DecodeWav[0][0])
	{
		decode_wav();
		return (0);
	}

	if (HostPort[0])
		port = atoi(HostPort);

	if (CATPort[0])
	{
		char * Baud = strlop(CATPort, ':');
		if (Baud)
			CATBAUD = atoi(Baud);

		hCATDevice = OpenCOMPort(CATPort, CATBAUD, FALSE, FALSE, FALSE, 0);

	}

	if (PTTPort[0])
	{
		int fd;

		if (strstr(PTTPort, "hidraw"))
		{
			// Linux - Param is HID Device, eg /dev/hidraw0

			CM108Device = strdup(PTTPort);
			fd = open (CM108Device, O_WRONLY);

			if (fd == -1)
			{
				ZF_LOGE("Could not open %s for write, errno=%d", CM108Device, errno);
			}
			else
			{
				close (fd);
				PTTMode = PTTCM108;
				RadioControl = TRUE;
				ZF_LOGI("Using %s for PTT", CM108Device);
			}
		}
		else
		{
			char * Baud = strlop(PTTPort, ':');
			char * pin = strlop(PTTPort, '=');

			if (Baud)
				PTTBAUD = atoi(Baud);

			if (strcmp(CATPort, PTTPort) == 0)
			{
				hPTTDevice = hCATDevice;
			}
			else
			{
				if (stricmp(PTTPort, "GPIO") == 0)
				{
					// Initialise GPIO for PTT if available

#if defined(__ARM_ARCH) && defined(__linux__)
					if (gpioInitialise() == 0)
					{
						printf("GPIO interface for PTT available\n");
						gotGPIO = TRUE;

						if (pin)
							pttGPIOPin = atoi(pin);
						else
							pttGPIOPin = 17;

						SetupGPIOPTT();
					}
					else
						printf("Couldn't initialise GPIO interface for PTT\n");

#else
					printf("GPIO interface for PTT not available on this platform\n");
#endif

				}
				else  // Not GPIO
				{
					if (Baud)
					{
						// Could be IPADDR:PORT or COMPORT:SPEED. See if first part is valid ip address

						struct sockaddr_in * destaddr = (struct sockaddr_in *)&HamlibAddr;

						destaddr->sin_family = AF_INET;
						destaddr->sin_addr.s_addr = inet_addr(PTTPort);
						destaddr->sin_port = htons(atoi(Baud));

						if (destaddr->sin_addr.s_addr != INADDR_NONE)
						{
							useHamLib = 1;
							ZF_LOGI("Using Hamlib at %s:%s for PTT", PTTPort, Baud);
							RadioControl = TRUE;
							PTTMode = PTTHAMLIB;
						}
						else
							PTTBAUD = atoi(Baud);
					}
					if (useHamLib == 0)
						hPTTDevice = OpenCOMPort(PTTPort, PTTBAUD, FALSE, FALSE, FALSE, 0);
				}
			}
		}
	}

	if (hCATDevice)
	{
		ZF_LOGI("CAT Control on port %s", CATPort);
		COMSetRTS(hPTTDevice);
		COMSetDTR(hPTTDevice);
		if (PTTOffCmdLen)
		{
			ZF_LOGI("PTT using CAT Port: %s", CATPort);
			RadioControl = TRUE;
		}
	}
	else
	{
		// Warn of -u and -k defined but no CAT Port

		if (PTTOffCmdLen)
		{
			ZF_LOGW("Warning PTT Off string defined but no CAT port");
		}
	}

	if (hPTTDevice)
	{
		ZF_LOGI("Using RTS on port %s for PTT", PTTPort);
		COMClearRTS(hPTTDevice);
		COMClearDTR(hPTTDevice);
		RadioControl = TRUE;
	}


	ZF_LOGI("ARDOPC listening on port %d", port);

	// Get Time Reference

	clock_gettime(CLOCK_MONOTONIC, &time_start);
	LastNow = getTicks();

	// Trap signals

	memset (&act, '\0', sizeof(act));

	act.sa_handler = &signal_handler_trigger_shutdown;
	if (sigaction(SIGINT, &act, NULL) < 0)
		perror ("SIGINT");

	act.sa_handler = &signal_handler_trigger_shutdown;
	if (sigaction(SIGTERM, &act, NULL) < 0)
		perror ("SIGTERM");

	act.sa_handler = SIG_IGN;

	if (sigaction(SIGHUP, &act, NULL) < 0)
		perror ("SIGHUP");

	if (sigaction(SIGPIPE, &act, NULL) < 0)
		perror ("SIGPIPE");

	ardopmain();

	// WL2GO: finalize any open recordings. WriteWav fills the RIFF and data
	// sizes in only when a file is closed; a session ended by SIGTERM (which is
	// how the host app stops the modem) otherwise leaves WAVs whose headers
	// claim zero samples, which the offline replay tool reads as an empty file.
	if (rxwf != NULL)
	{
		CloseWav(rxwf);
		rxwf = NULL;
	}
	if (txwff != NULL)
	{
		CloseWav(txwff);
		txwff = NULL;
	}

	CloseSound();

	return (0);
}

void txSleep(int mS)
{
	// called while waiting for next TX buffer or to delay response.
	// Run background processes

	TCPHostPoll();
	WebguiPoll();

	if (strcmp(PlaybackDevice, "NOSOUND") != 0)
		Sleep(mS);

	if (PKTLEDTimer && Now > PKTLEDTimer)
	{
		PKTLEDTimer = 0;
		SetLED(PKTLED, 0);  // turn off packet rxed led
	}
}

// PortAudio Code
//
// Replaces the ALSA-specific section of src/linux/ALSASound.c with a
// PortAudio implementation. PortAudio speaks CoreAudio, WASAPI/WinMM and
// ALSA/PulseAudio/JACK, so this one file serves every platform rather than
// requiring a separate backend per operating system.
//
// The surrounding glue (platform_main, timing, PTT, WAV capture) is kept
// unchanged from upstream so behaviour outside audio I/O is identical.

#include "portaudio.h"

#define true 1
#define false 0

PaStream *	playhandle = NULL;
PaStream *	rechandle = NULL;

int m_playchannels = 1;
int m_recchannels = 1;

char SavedCaptureDevice[256];  // Saved so we can reopen
char SavedPlaybackDevice[256];

int Savedplaychannels = 1;

int SavedCaptureRate;
int SavedPlaybackRate;

// This rather convoluted process simplifies marshalling from Managed Code

char ** WriteDevices = NULL;
int WriteDeviceCount = 0;

char ** ReadDevices = NULL;
int ReadDeviceCount = 0;

static int paIsInitialised = FALSE;

// Routine to check that library is available

int CheckifLoaded()
{
	// Prevent CTRL/C from closing the TNC
	// (This causes problems if the TNC is started by LinBPQ)

	signal(SIGHUP, SIG_IGN);
	signal(SIGINT, SIG_IGN);
	signal(SIGPIPE, SIG_IGN);

	return TRUE;
}

static int EnsurePaInit()
{
	PaError err;

	if (paIsInitialised)
		return TRUE;

	err = Pa_Initialize();

	if (err != paNoError)
	{
		ZF_LOGE("Pa_Initialize() failed: %s", Pa_GetErrorText(err));
		return FALSE;
	}

	paIsInitialised = TRUE;
	return TRUE;
}

/*
 * Resolve a user-supplied device string to a PortAudio device index.
 *
 * Accepts either a numeric index as printed by the device list, or a
 * case-insensitive substring of the device name. Windows users of ardopcf are
 * used to selecting by number and Linux users by name, so both are honoured on
 * every platform. An empty string or "DEFAULT" selects the system default.
 */
static PaDeviceIndex ResolveDevice(char * name, int wantInput)
{
	PaDeviceIndex count = Pa_GetDeviceCount();
	PaDeviceIndex i;
	const PaDeviceInfo * info;
	char * endptr;
	long asNumber;

	if (count <= 0)
		return paNoDevice;

	if (name == NULL || name[0] == 0 || stricmp((unsigned char *)name, (unsigned char *)"DEFAULT") == 0)
		return wantInput ? Pa_GetDefaultInputDevice() : Pa_GetDefaultOutputDevice();

	// Numeric index, as shown in the startup device listing.

	asNumber = strtol(name, &endptr, 10);

	if (*endptr == 0 && endptr != name)
	{
		if (asNumber >= 0 && asNumber < count)
		{
			info = Pa_GetDeviceInfo((PaDeviceIndex)asNumber);

			if (info && ((wantInput && info->maxInputChannels > 0) ||
				(!wantInput && info->maxOutputChannels > 0)))
				return (PaDeviceIndex)asNumber;
		}

		ZF_LOGE("Device number %ld is not a valid %s device.", asNumber, wantInput ? "capture" : "playback");
		return paNoDevice;
	}

	// Otherwise match a substring of the device name.

	for (i = 0; i < count; i++)
	{
		info = Pa_GetDeviceInfo(i);

		if (info == NULL)
			continue;

		if (wantInput && info->maxInputChannels <= 0)
			continue;

		if (!wantInput && info->maxOutputChannels <= 0)
			continue;

		if (strcasestr(info->name, name) != NULL)
			return i;
	}

	return paNoDevice;
}

static void FreeDeviceList(char *** list, int * count)
{
	int i;

	if (*list)
	{
		for (i = 0; i < *count; i++)
			free((*list)[i]);

		free(*list);
	}

	*list = NULL;
	*count = 0;
}

static int CollectDevices(int wantInput, char *** list, int * count)
{
	PaDeviceIndex total;
	PaDeviceIndex i;
	const PaDeviceInfo * info;
	char NameString[256];

	FreeDeviceList(list, count);

	if (!EnsurePaInit())
		return 0;

	total = Pa_GetDeviceCount();

	if (total < 0)
	{
		ZF_LOGE("Pa_GetDeviceCount() failed: %s", Pa_GetErrorText(total));
		return 0;
	}

	ZF_LOGI("%s Devices", wantInput ? "Capture" : "Playback");

	for (i = 0; i < total; i++)
	{
		info = Pa_GetDeviceInfo(i);

		if (info == NULL)
			continue;

		if (wantInput && info->maxInputChannels <= 0)
			continue;

		if (!wantInput && info->maxOutputChannels <= 0)
			continue;

		snprintf(NameString, sizeof(NameString), "%d %s", (int)i, info->name);

		*list = realloc(*list, (*count + 1) * sizeof(char *));
		(*list)[*count] = strdup(NameString);
		(*count)++;

		ZF_LOGI("%s", NameString);
	}

	return *count;
}

int GetOutputDeviceCollection()
{
	return CollectDevices(FALSE, &WriteDevices, &WriteDeviceCount);
}

int GetNextOutputDevice(char * dest, int max, int n)
{
	dest[0] = 0;

	if (n >= WriteDeviceCount)
		return 0;

	strncpy(dest, WriteDevices[n], max - 1);
	dest[max - 1] = 0;
	return strlen(dest);
}

int GetInputDeviceCollection()
{
	return CollectDevices(TRUE, &ReadDevices, &ReadDeviceCount);
}

int GetNextInputDevice(char * dest, int max, int n)
{
	dest[0] = 0;

	if (n >= ReadDeviceCount)
		return 0;

	strncpy(dest, ReadDevices[n], max - 1);
	dest[max - 1] = 0;
	return strlen(dest);
}

/*
 * Reports whether a device can be opened the way ardopcf actually opens it:
 * 12000 Hz, one channel, paInt16. The parameters mirror OpenPaStream() exactly,
 * suggestedLatency included, so the answer is about the same request the modem
 * will make rather than a differently-shaped one.
 *
 * This is a prediction, not a guarantee. Some host APIs (CoreAudio in
 * particular) resample transparently, so Pa_IsFormatSupported can refuse a
 * device that Pa_OpenStream would then accept. The host program is expected to
 * treat a "no" as a warning worth showing, never as a reason to refuse the
 * device -- the open is the only real answer.
 */
static int SupportsModemFormat(PaDeviceIndex device, const PaDeviceInfo * info, int isInput)
{
	PaStreamParameters params;

	memset(&params, 0, sizeof(params));
	params.device = device;
	params.channelCount = 1;
	params.sampleFormat = paInt16;
	params.suggestedLatency = isInput ? info->defaultLowInputLatency : info->defaultLowOutputLatency;
	params.hostApiSpecificStreamInfo = NULL;

	return Pa_IsFormatSupported(isInput ? &params : NULL, isInput ? NULL : &params, 12000)
		== paFormatIsSupported;
}

static void PrintDeviceLine(PaDeviceIndex index, const PaDeviceInfo * info, int isInput)
{
	const PaHostApiInfo * hostApi = Pa_GetHostApiInfo(info->hostApi);
	PaDeviceIndex defaultDevice = isInput ? Pa_GetDefaultInputDevice() : Pa_GetDefaultOutputDevice();

	printf("%s\t%d\t%s\t%d\t%s\t12k=%s\t%s\n",
		isInput ? "CAPTURE" : "PLAYBACK",
		(int)index,
		(hostApi && hostApi->name) ? hostApi->name : "unknown",
		isInput ? info->maxInputChannels : info->maxOutputChannels,
		index == defaultDevice ? "default" : "-",
		SupportsModemFormat(index, info, isInput) ? "yes" : "no",
		info->name);
}

/*
 * Machine-readable device listing for host applications.
 *
 * Prints a version header followed by one line per device:
 *
 *   #ARDOPCF-DEVICE-LIST 2
 *   <KIND>\t<index>\t<host API>\t<channels>\t<default|->\t12k=<yes|no>\t<name>
 *
 * A device that both captures and plays back is listed once for each role.
 *
 * The name is deliberately LAST, because it is the one field that comes from
 * the driver and could itself contain a tab; every fixed field is parseable
 * before that point. The header exists so a host program can tell an old
 * binary from a new one instead of mis-parsing its output -- the previous
 * version of this listing had three columns and no header.
 *
 * A host program otherwise has no way to enumerate devices: InitSound() skips
 * enumeration entirely for the NOSOUND device, and any other name makes
 * ardopcf open a stream and exit if it fails. Printing to stdout (rather than
 * the log) keeps the output usable before logging has been started.
 */
int ListAudioDevices()
{
	PaDeviceIndex total;
	PaDeviceIndex i;
	const PaDeviceInfo * info;

	if (!EnsurePaInit())
	{
		fprintf(stderr, "Could not initialise the audio system.\n");
		return 1;
	}

	total = Pa_GetDeviceCount();

	if (total < 0)
	{
		fprintf(stderr, "Pa_GetDeviceCount() failed: %s\n", Pa_GetErrorText(total));
		return 1;
	}

	printf("#ARDOPCF-DEVICE-LIST 2\n");

	for (i = 0; i < total; i++)
	{
		info = Pa_GetDeviceInfo(i);

		if (info == NULL)
			continue;

		if (info->maxInputChannels > 0)
			PrintDeviceLine(i, info, TRUE);

		if (info->maxOutputChannels > 0)
			PrintDeviceLine(i, info, FALSE);
	}

	fflush(stdout);
	Pa_Terminate();
	paIsInitialised = FALSE;
	return 0;
}

/*
 * WL2GO: the capture ring.
 *
 * The CoreAudio thread deposits samples here from CaptureCallback and the
 * main loop takes them out in SoundCardRead -- single producer, single
 * consumer, monotonic 64-bit counters masked into a power-of-two buffer.
 * Samples are stored exactly as the device delivers them (interleaved when
 * the device is stereo); the reader deinterleaves.
 *
 * 65536 samples is 2.7 s of mono 12 kHz audio: room for the whole of a
 * transmission's worth of stale input (discarded wholesale in StartCapture)
 * plus any conceivable main-loop stall, where PortAudio's own blocking-API
 * ring held 21 ms and threw away one sample in five.
 */
#define CAPRINGSAMPLES 65536  // must be a power of two
static short CapRing[CAPRINGSAMPLES];
static unsigned long long CapWr = 0;  // total samples ever written; owned by the callback
static unsigned long long CapRd = 0;  // total samples ever read; owned by the main loop
static volatile int CapDropped = 0;  // set by the callback, logged and cleared by the reader

static int CaptureCallback(const void * input, void * output,
	unsigned long frameCount, const PaStreamCallbackTimeInfo * timeInfo,
	PaStreamCallbackFlags statusFlags, void * userData)
{
	// Real-time audio thread: no logging, no allocation, no blocking.
	const short * in = (const short *)input;
	unsigned long long wr = CapWr;
	unsigned long long rd = __atomic_load_n(&CapRd, __ATOMIC_ACQUIRE);
	unsigned long long space = CAPRINGSAMPLES - (wr - rd);
	unsigned long nsamples = frameCount * m_recchannels;
	unsigned long i;

	(void)output; (void)timeInfo; (void)userData;

	if (in == NULL)  // hosts may pass NULL input in fault conditions
		return paContinue;

	if (statusFlags & paInputOverflow)
		CapDropped = 1;

	if (nsamples > space)
	{
		CapDropped = 1;
		nsamples = (unsigned long)space;
	}

	for (i = 0; i < nsamples; i++)
		CapRing[(wr + i) & (CAPRINGSAMPLES - 1)] = in[i];

	__atomic_store_n(&CapWr, wr + nsamples, __ATOMIC_RELEASE);

	return paContinue;
}

static int OpenPaStream(PaStream ** stream, PaDeviceIndex device, int channels,
	int sampleRate, int isInput, char * ErrorMsg)
{
	PaStreamParameters params;
	const PaDeviceInfo * info = Pa_GetDeviceInfo(device);
	PaError err;

	if (info == NULL)
	{
		if (ErrorMsg)
			sprintf(ErrorMsg, "No such audio device");

		return FALSE;
	}

	memset(&params, 0, sizeof(params));
	params.device = device;
	params.channelCount = channels;
	params.sampleFormat = paInt16;

	params.suggestedLatency = isInput ? info->defaultLowInputLatency : info->defaultLowOutputLatency;
	params.hostApiSpecificStreamInfo = NULL;

	// WL2GO: capture uses the CALLBACK API; playback stays blocking.
	//
	// The blocking read API is unusable here. PortAudio implements it on top
	// of an internal ring it sizes from suggestedLatency and framesPerBuffer
	// (pa_mac_core_utilities.c, computeRingBufferSize): the defaults give
	// ~256 samples -- 21 ms, less than one main-loop pass -- so it sat
	// permanently full and ~20% of everything the radio sent was discarded
	// before it could be read. And both knobs that would deepen it also
	// enlarge the AudioUnit slice, which on this hardware (12000 Hz stream
	// over a 48000 Hz native device) made AudioUnitRender fail with paramErr
	// (-50) and the stream silently stop delivering -- reliably inside the
	// full app, intermittently standalone.
	//
	// The callback keeps the AudioUnit at exactly the default configuration
	// every reliable session has used, and copies into CapRing, whose depth
	// we control (2.7 s). Playback keeps the blocking API unchanged: its flow
	// control is Pa_WriteStream blocking, which has never dropped a sample.
	err = Pa_OpenStream(
		stream,
		isInput ? &params : NULL,
		isInput ? NULL : &params,
		sampleRate,
		paFramesPerBufferUnspecified,
		paNoFlag,
		isInput ? CaptureCallback : NULL,
		NULL);

	if (err != paNoError)
	{
		ZF_LOGE("Pa_OpenStream(%s, %s) failed: %s", isInput ? "capture" : "playback",
			info->name, Pa_GetErrorText(err));

		if (ErrorMsg)
			sprintf(ErrorMsg, "Could not open %s device %s: %s",
				isInput ? "capture" : "playback", info->name, Pa_GetErrorText(err));

		*stream = NULL;
		return FALSE;
	}

	err = Pa_StartStream(*stream);

	if (err != paNoError)
	{
		ZF_LOGE("Pa_StartStream() failed: %s", Pa_GetErrorText(err));

		if (ErrorMsg)
			sprintf(ErrorMsg, "Could not start %s stream: %s",
				isInput ? "capture" : "playback", Pa_GetErrorText(err));

		Pa_CloseStream(*stream);
		*stream = NULL;
		return FALSE;
	}

	// WL2GO: also report the device's native rate. The modem always opens at
	// 12000 Hz and CoreAudio resamples; a native rate that is not an integer
	// multiple of 12000 (44100, say) makes that conversion non-integer, and
	// that is worth being able to see in a session log after the fact.
	ZF_LOGI("Opened %s device %s at %d Hz, %d channel(s) (device native rate %.0f Hz)",
		isInput ? "capture" : "playback", info->name, sampleRate, channels,
		info->defaultSampleRate);

	return TRUE;
}

int OpenSoundPlayback(char * PlaybackDevice, int m_sampleRate, int channels, char * ErrorMsg)
{
	PaDeviceIndex device;

	if (ErrorMsg)
		ErrorMsg[0] = 0;

	if (!EnsurePaInit())
	{
		if (ErrorMsg)
			sprintf(ErrorMsg, "Could not initialise the audio system");

		return FALSE;
	}

	if (playhandle)
	{
		Pa_CloseStream(playhandle);
		playhandle = NULL;
	}

	// WL2GO: guarded because two callers pass SavedPlaybackDevice back in as
	// PlaybackDevice -- StopCapture() at every transmission under SHARECAPTURE,
	// and the underrun recovery in SendtoCard(). That makes this
	// strncpy(x, x, n), and macOS's fortified __strncpy_chk traps on overlapping
	// source and destination: SIGTRAP, process gone, mid-transmission.
	//
	// glibc does not check, which is why this has never been seen on Linux. On
	// macOS it meant ardopcf died on EVERY transmission -- and because it dies
	// AFTER KeyPTT(TRUE) and before SoundFlush's KeyPTT(FALSE), it left the
	// radio keyed with no audio. Found via the two-tone test, 2026-08-27.
	if (SavedPlaybackDevice != PlaybackDevice) {
		strncpy(SavedPlaybackDevice, PlaybackDevice, sizeof(SavedPlaybackDevice) - 1);
		SavedPlaybackDevice[sizeof(SavedPlaybackDevice) - 1] = 0;
	}
	SavedPlaybackRate = m_sampleRate;
	Savedplaychannels = m_playchannels = channels;

	device = ResolveDevice(PlaybackDevice, FALSE);

	if (device == paNoDevice)
	{
		ZF_LOGE("Playback device '%s' not found.", PlaybackDevice);

		if (ErrorMsg)
			sprintf(ErrorMsg, "Playback device '%s' not found", PlaybackDevice);

		return FALSE;
	}

	return OpenPaStream(&playhandle, device, channels, m_sampleRate, FALSE, ErrorMsg);
}

int OpenSoundCapture(char * CaptureDevice, int m_sampleRate, char * ErrorMsg)
{
	PaDeviceIndex device;

	if (ErrorMsg)
		ErrorMsg[0] = 0;

	if (!EnsurePaInit())
	{
		if (ErrorMsg)
			sprintf(ErrorMsg, "Could not initialise the audio system");

		return FALSE;
	}

	if (rechandle)
	{
		Pa_CloseStream(rechandle);
		rechandle = NULL;
	}

	// WL2GO: same overlapping-copy trap as OpenSoundPlayback above. Three
	// callers pass SavedCaptureDevice straight back in, including SoundFlush()
	// reopening capture after every transmission.
	if (SavedCaptureDevice != CaptureDevice) {
		strncpy(SavedCaptureDevice, CaptureDevice, sizeof(SavedCaptureDevice) - 1);
		SavedCaptureDevice[sizeof(SavedCaptureDevice) - 1] = 0;
	}
	SavedCaptureRate = m_sampleRate;

	device = ResolveDevice(CaptureDevice, TRUE);

	if (device == paNoDevice)
	{
		ZF_LOGE("Capture device '%s' not found.", CaptureDevice);

		if (ErrorMsg)
			sprintf(ErrorMsg, "Capture device '%s' not found", CaptureDevice);

		return FALSE;
	}

	if (!OpenPaStream(&rechandle, device, m_recchannels, m_sampleRate, TRUE, ErrorMsg))
		return FALSE;

	// WL2GO: upstream only starts the recorder in SoundFlush(), so -w writes
	// nothing until after the first transmission. StartRxWav() is idempotent.
	if (WriteRxWav)
		StartRxWav();

	return TRUE;
}

int OpenSoundCard(char * CaptureDevice, char * PlaybackDevice, int c_sampleRate, int p_sampleRate, char * ErrorMsg)
{
	ZF_LOGI("Opening Playback Device %s Rate %d", PlaybackDevice, p_sampleRate);

	if (!OpenSoundPlayback(PlaybackDevice, p_sampleRate, m_playchannels, ErrorMsg))
		return FALSE;

	ZF_LOGI("Opening Capture Device %s Rate %d", CaptureDevice, c_sampleRate);

	return OpenSoundCapture(CaptureDevice, c_sampleRate, ErrorMsg);
}

int CloseSoundCard()
{
	// WL2GO: stop before close. Pa_CloseStream on an active stream aborts it,
	// which on CoreAudio tears the IOProc down out from under coreaudiod;
	// Pa_StopStream first winds it down in order. The stop can fail (device
	// already gone) -- close regardless.
	if (rechandle)
	{
		Pa_StopStream(rechandle);
		Pa_CloseStream(rechandle);
		rechandle = NULL;
	}

	if (playhandle)
	{
		Pa_StopStream(playhandle);
		Pa_CloseStream(playhandle);
		playhandle = NULL;
	}

	return 0;
}

/*
 * Upstream's ALSA version builds the outgoing frame in a 256000-element array
 * on the stack -- half a megabyte, which overflows the default stack of any
 * secondary thread on several platforms. A file-scope buffer avoids that while
 * keeping the same conversion logic.
 */
static short txsamples[2 * SendSize];

int PackSamplesAndSend(short * input, int nSamples)
{
	short * sampptr = txsamples;
	int n;
	PaError err;

	if (playhandle == NULL)
		return 0;

	if (nSamples > SendSize)
	{
		ZF_LOGE("PackSamplesAndSend asked for %d samples, buffer holds %d.", nSamples, SendSize);
		nSamples = SendSize;
	}

	if (m_playchannels == 1)
	{
		for (n = 0; n < nSamples; n++)
			*(sampptr++) = input[n];
	}
	else
	{
		for (n = 0; n < nSamples; n++)
		{
			*(sampptr++) = UseLeftTX ? input[n] : 0;
			*(sampptr++) = UseRightTX ? input[n] : 0;
		}
	}

	err = Pa_WriteStream(playhandle, txsamples, nSamples);

	if (err != paNoError && err != paOutputUnderflowed)
	{
		ZF_LOGE("Pa_WriteStream() failed: %s", Pa_GetErrorText(err));
		return 0;
	}

	return nSamples;
}

int SoundCardWrite(short * input, unsigned int nSamples)
{
	signed long avail;

	if (playhandle == NULL)
		return 0;

	// WL2GO: the capture stream STAYS OPEN across a transmission.
	//
	// Upstream closes it here and reopens it in SoundFlush() so a half-duplex
	// interface is not held open both ways. On CoreAudio that close/reopen
	// costs real audio: a session recording carried 17 dropouts of true digital
	// silence, up to 28 ms, that standalone captures of the same device do not
	// have at all. A 4FSK symbol is 20 ms, so a 28 ms hole destroys a frame
	// outright -- which is how a station answering at 20 dB SNR still failed
	// every frame-type decode.
	//
	// Capturing is already FALSE for the whole transmission (Modulate.c:701),
	// so nothing reaches the decoder meanwhile; the only thing the close bought
	// was releasing the device, and the codecs this talks to are full duplex.
	// The ring that fills during transmit is drained in StartCapture().

	avail = Pa_GetStreamWriteAvailable(playhandle);

	if (avail < 0)
	{
		ZF_LOGD("Playback available returned %s, reopening.", Pa_GetErrorText((PaError)avail));

		Pa_CloseStream(playhandle);
		playhandle = NULL;

		if (!OpenSoundPlayback(SavedPlaybackDevice, SavedPlaybackRate, Savedplaychannels, NULL))
			return 0;

		avail = Pa_GetStreamWriteAvailable(playhandle);
	}

	// WL2GO: upstream's "wait until the stream reports room for the whole block"
	// loop is DELETED here, not merely bounded.
	//
	//	while (avail >= 0 && (unsigned int)avail < nSamples) { txSleep(100); ... }
	//
	// On CoreAudio that condition can never become true. PortAudio's internal
	// buffer for a blocking stream opened with paFramesPerBufferUnspecified is
	// smaller than the 1200 samples ardopcf writes at a time, so avail plateaus
	// below nSamples and the loop spins forever -- with the transmitter KEYED.
	// Confirmed by stack sample: SoundCardWrite -> txSleep -> usleep, after
	// KeyPTT(TRUE) and before SoundFlush's KeyPTT(FALSE). Bounding the wait was
	// tried first and is not enough: 250 blocks each burning a timeout turns a
	// five-second test into two minutes of dead carrier.
	//
	// Nothing is lost by removing it. Pa_WriteStream() is a BLOCKING call that
	// waits for room itself and writes the whole block however small the
	// device buffer is -- which is what upstream's ALSA original relied on too.
	// The avail < 0 branch above is kept: that is genuine error recovery, not
	// flow control.

	return PackSamplesAndSend(input, nSamples);
}

int PriorSize = 0;

int Index = 0;  // DMA Buffer being used 0 or 1
int inIndex = 0;  // DMA Buffer being used 0 or 1

BOOL DMARunning = FALSE;  // Used to start DMA on first write

static unsigned int dttLastCaptureReopen = 0;

int SoundCardRead(short * input, unsigned int nSamples)
{
	unsigned long long wr, rd;
	unsigned int nring;
	unsigned int n;
	int start;

	if (rechandle == NULL)
		return 0;

	if (nSamples > ReceiveSize)
	{
		ZF_LOGE("SoundCardRead asked for %d samples, buffer holds %d.", nSamples, ReceiveSize);
		return 0;
	}

	// WL2GO: watchdog. A CoreAudio fault inside the callback machinery stops
	// the stream without any error reaching this thread -- one session ran
	// start to finish with a stream that died 27 ms after opening, and the
	// only symptom was silence. An inactive stream here is always wrong, so
	// say so loudly and reopen, at most once a second.
	if (Pa_IsStreamActive(rechandle) == 0 && (Now - dttLastCaptureReopen) > 1000)
	{
		dttLastCaptureReopen = Now;
		ZF_LOGE("Capture stream stopped unexpectedly; reopening.");

		Pa_CloseStream(rechandle);
		rechandle = NULL;

		if (!OpenSoundCapture(SavedCaptureDevice, SavedCaptureRate, NULL))
			return 0;
	}

	// WL2GO: a drop means the callback found CapRing full, or CoreAudio itself
	// reported input overflow. Silent loss makes a starved decoder
	// indistinguishable from a station that never answered, so always log it.
	if (CapDropped)
	{
		CapDropped = 0;
		ZF_LOGD("Capture overflow: samples were lost before they could be read.");
	}

	// Non-blocking by contract: the caller polls, so return nothing rather
	// than waiting for the card to fill.

	nring = nSamples * m_recchannels;
	wr = __atomic_load_n(&CapWr, __ATOMIC_ACQUIRE);
	rd = CapRd;

	if (wr - rd < nring)
		return 0;

	if (m_recchannels == 1)
	{
		for (n = 0; n < nSamples; n++)
			input[n] = CapRing[(rd + n) & (CAPRINGSAMPLES - 1)];
	}
	else
	{
		// Deinterleave the selected channel into the caller's mono buffer.
		start = UseLeftRX ? 0 : 1;

		for (n = 0; n < nSamples; n++)
			input[n] = CapRing[(rd + (unsigned int)(n * 2) + start) & (CAPRINGSAMPLES - 1)];
	}

	__atomic_store_n(&CapRd, rd + nring, __ATOMIC_RELEASE);

	return nSamples;
}
short * SendtoCard(short * buf, int n)
{
	if (Loopback)
	{
		// Loop back   to decode for testing

		ProcessNewSamples(buf, 1200);  // signed
	}

	// WL2GO: once a shutdown signal has arrived, stop feeding the card.
	// Pa_WriteStream blocks for the duration of each block, so a transmission
	// in progress would otherwise hold SIGTERM off until it finished playing --
	// past the host app's kill grace, earning a SIGKILL with live CoreAudio
	// streams. SoundFlush still runs and unkeys PTT on the way out.
	if (playhandle && !blnClosing)
		SoundCardWrite(&buffer[Index][0], n);
	if (txwff != NULL)
		WriteWav(&buffer[Index][0], n, txwff);

//	txSleep(10);  // Run buckground while waiting

	return &buffer[Index][0];
}

short loopbuff[1200];  // Temp for testing - loop sent samples to decoder


// This generates a nice musical pattern for sound interface testing
// for (t = 0; t < sizeof(buffer); ++t)
//  buffer[t] =((((t * (t >> 8 | t >> 9) & 46 & t >> 8)) ^ (t & t >> 13 | t >> 6)) & 0xFF);



int InitSound(BOOL Quiet)
{
	if (strcmp(PlaybackDevice, "NOSOUND") == 0)
		return (1);
	GetInputDeviceCollection();
	GetOutputDeviceCollection();
	return OpenSoundCard(CaptureDevice, PlaybackDevice, 12000, 12000, NULL);
}

int min = 0, max = 0, lastlevelreport = 0, lastlevelGUI = 0;
UCHAR CurrentLevel = 0;  // Peak from current samples


void PollReceivedSamples()
{
	int blocks = 0;

	if (strcmp(PlaybackDevice, "NOSOUND") == 0)
		return;

	// Process any captured samples
	// Ideally call at least every 100 mS, more than 200 will loose data

	// WL2GO: drain everything the ring holds, not one block per call.
	//
	// Upstream reads a single 240-sample block -- 20 ms of audio -- each time
	// this is called, and the main loop calls it roughly every 25 ms here. That
	// consumes at most ~9600 samples/s from a 12000 samples/s stream, so the
	// ring sat permanently full and CoreAudio discarded ~20% of everything the
	// radio sent: every frame shredded while the recording still sounded clean
	// by ear. ALSA hid the same shape behind a buffer seconds deep; CoreAudio's
	// default ring is a few tens of milliseconds. The bound only guards against
	// a runaway producer -- 50 blocks lets one poll clear a second of backlog.
	while (blocks++ < 50 && SoundCardRead(&inbuffer[0][0], ReceiveSize))
	{
		// returns ReceiveSize or none

		short * ptr = &inbuffer[0][0];
		int i;

		if (add_noise(&inbuffer[0][0], ReceiveSize, InputNoiseStdDev) > 0) {
			max = 32767;
			min = -32768;
		} else {
			for (i = 0; i < ReceiveSize; i++)
			{
				if (*(ptr) < min)
					min = *ptr;
				else if (*(ptr) > max)
					max = *ptr;
				ptr++;
			}
		}

		CurrentLevel = ((max - min) * 75) /32768;  // Scale to 150 max
		wg_send_currentlevel(0, CurrentLevel);

		if ((Now - lastlevelGUI) > 2000)  // 2 Secs
		{
			if (WaterfallActive == 0 && SpectrumActive == 0)  // Don't need to send as included in Waterfall Line
				SendtoGUI('L', &CurrentLevel, 1);  // Signal Level

			lastlevelGUI = Now;

			if ((Now - lastlevelreport) > 10000)  // 10 Secs
			{
				lastlevelreport = Now;
				// Report input peaks to host and log if CONSOLELOG is ZF_LOG_DEBUG (2) or ZF_LOG_VERBOSE (1) or if close to clipping
				// TODO: Are these good conditions for logging (and sending to host) Input Peaks values?
				// Conditions were changed with the introduction of ZF_LOG, but are now restored.
				if (max >= 32000 || ardop_log_get_level_console() <= ZF_LOG_DEBUG)
				{
					char HostCmd[64] = "";
					snprintf(HostCmd, sizeof(HostCmd), "INPUTPEAKS %d %d", min, max);
					SendCommandToHostQuiet(HostCmd);
					ZF_LOGD("Input peaks = %d, %d", min, max);
					// A user with the default of CONSOLELOG = ZF_LOG_INFO will see this message if they are close to clipping
					if (ardop_log_get_level_console() > ZF_LOG_DEBUG)
					{
						ZF_LOGI(
							"Your input signal is probably clipping. If you see"
							" this message repeated in the next 20-30 seconds,"
							" Turn down your RX input until this message stops"
							" repeating."
						);
					}
				}
			}
			min = max = 0;  // Every 2 secs
		}

		if (rxwf != NULL)
		{
			// There is an open Wav file recording.
			// Either close it or write samples to it.
			if (rxwf_EndNow < Now)
			{
				CloseWav(rxwf);
				rxwf = NULL;
			}
			else
				WriteWav(&inbuffer[0][0], ReceiveSize, rxwf);
		}


		if (Capturing && Loopback == FALSE)
			ProcessNewSamples(&inbuffer[0][0], ReceiveSize);
	}
}

void StopCapture()
{
	Capturing = FALSE;

	if (strcmp(PlaybackDevice, "NOSOUND") == 0)
		return;

#ifdef SHARECAPTURE

	// Stopcapture is only called when we are about to transmit, so use it to open plaback device. We don't keep
	// it open all the time to facilitate sharing.

	OpenSoundPlayback(SavedPlaybackDevice, SavedPlaybackRate, Savedplaychannels, NULL);
#endif
}

void StartCodec(char * strFault)
{
	strFault[0] = 0;
	OpenSoundCard(CaptureDevice, PlaybackDevice, 12000, 12000, strFault);
}

void StopCodec(char * strFault)
{
	strFault[0] = 0;
	CloseSoundCard();
}

void StartCapture()
{
	Capturing = TRUE;
	DiscardOldSamples();
	ClearAllMixedSamples();
	State = SearchingForLeader;

	// WL2GO: throw away what arrived while we were transmitting.
	//
	// The stream stays open across a transmission, so by here CapRing holds a
	// couple of seconds of our own sidetone and silence. Left there it would
	// be decoded as if it were current, and every read would sit that far
	// behind real time.
	__atomic_store_n(&CapRd, __atomic_load_n(&CapWr, __ATOMIC_ACQUIRE), __ATOMIC_RELEASE);
	CapDropped = 0;

//	Debugprintf("Start Capture");
}
void CloseSound()
{
	CloseSoundCard();

	// WL2GO: deregister from the audio system, don't just die out of it.
	// Pa_Terminate() is what removes this process's HAL client and its
	// property listeners from coreaudiod; every prior shutdown skipped it, and
	// a day of repeated modem restarts left coreaudiod in a state that
	// crackled system-wide until the daemon itself was restarted.
	if (paIsInitialised)
	{
		Pa_Terminate();
		paIsInitialised = FALSE;
	}
}

VOID WriteSamples(short * buffer, int len)
{

#ifdef WIN32
	fwrite(buffer, 1, len * 2, wavfp1);
#endif
}

unsigned short * SoundInit()
{
	Index = 0;
	return &buffer[0][0];
}

// Called at end of transmission

void SoundFlush()
{
	// Append Trailer then send remaining samples

	int err, res;
	char strFault[100] = "";
	int count = 100;
	int lastavail = 0;
	int txlenMs = 0;

	AddTrailer();  // add the trailer.

	if (Loopback)
		ProcessNewSamples(&buffer[Index][0], Number);

	SendtoCard(&buffer[Index][0], Number);

	// Wait for tx to complete

	// samples sent is is in SampleNo, time started in mS is in pttOnTime.
	// calculate time to stop

	txlenMs = SampleNo / 12 + 20;  // 12000 samples per sec. 20 mS TXTAIL

	ZF_LOGD("Tx Time %d Time till end = %d", txlenMs, (pttOnTime + txlenMs) - Now);

	// WL2GO: blnClosing cuts the playout wait short so a SIGTERM received
	// mid-transmission exits within the host app's kill grace instead of
	// waiting for the whole frame to finish on air.
	if (strcmp(PlaybackDevice, "NOSOUND") != 0)
		while (Now < (pttOnTime + txlenMs) && !blnClosing)
		{
			usleep(2000);
		}

/*

	while (count-- && playhandle)
	{
		snd_pcm_sframes_t avail = snd_pcm_avail_update(playhandle);

		Debugprintf("Waiting for complete. Avail %d Max %d last %d", avail, MaxAvail, lastavail);

		snd_pcm_status_alloca(&status);  // alloca allocates once per function, does not need a free

		if ((err=snd_pcm_status(playhandle, status))!=0)
		{
			Debugprintf("snd_pcm_status() failed: %s",snd_strerror(err));
			break;
		}

		res = snd_pcm_status_get_state(status);

		Debugprintf("PCM Status = %d", res);

		// Some cards seem to stop sending but not report not running, so also check that avail is decreasing

		if (res != SND_PCM_STATE_RUNNING || lastavail == avail)  // If sound system is not running then it needs data
//		if (MaxAvail - avail < 100)
		{
			// Send complete - Restart Capture
			break;
		}
		lastavail = avail;
		usleep(50000);
	}
*/

	// I think we should turn round the link here. I dont see the point in
	// waiting for MainPoll

#ifdef SHARECAPTURE
	if (strcmp(PlaybackDevice, "NOSOUND") != 0) {
		if (playhandle)
		{
			Pa_CloseStream(playhandle);
			playhandle = NULL;
		}
	}
#endif
	SoundIsPlaying = FALSE;

	if (blnEnbARQRpt > 0 || blnDISCRepeating)  // Start Repeat Timer if frame should be repeated
		dttNextPlay = Now + intFrameRepeatInterval + extraDelay;

	KeyPTT(FALSE);  // Unkey the Transmitter
	if (txwff != NULL)
	{
		CloseWav(txwff);
		txwff = NULL;
	}
	// writing unfiltered tx audio to WAV disabled
	// if (txwfu != NULL)
	// {
		// CloseWav(txwfu);
		// txwfu = NULL;
	// }

	// Not reopened: it was never closed. Only reopen if something else dropped
	// it, so a stream lost to an error still recovers.
	if (strcmp(PlaybackDevice, "NOSOUND") != 0 && rechandle == NULL)
		OpenSoundCapture(SavedCaptureDevice, SavedCaptureRate, strFault);
	StartCapture();

	if (WriteRxWav)
		// Start recording if not already recording, else to extend the recording time.
		StartRxWav();
	return;
}

VOID RadioPTT(int PTTState)
{
#if defined(__ARM_ARCH) && defined(__linux__)
	if (useGPIO)
		gpioWrite(pttGPIOPin, (pttGPIOInvert ? (1-PTTState) : (PTTState)));
	else
#endif
	{
		if (PTTMode & PTTRTS)
			if (PTTState)
				COMSetRTS(hPTTDevice);
			else
				COMClearRTS(hPTTDevice);

		if (PTTMode & PTTDTR)
			if (PTTState)
				COMSetDTR(hPTTDevice);
			else
				COMClearDTR(hPTTDevice);

		if (PTTMode & PTTCI_V)
			if (PTTState)
				WriteCOMBlock(hCATDevice, PTTOnCmd, PTTOnCmdLen);
			else
				WriteCOMBlock(hCATDevice, PTTOffCmd, PTTOffCmdLen);

		if (PTTMode & PTTCM108)
			CM108_set_ptt(PTTState);
	}
}

// Function to send PTT TRUE or PTT FALSE commanad to Host or if local Radio control Keys radio PTT

const char BoolString[2][6] = {"FALSE", "TRUE"};

BOOL KeyPTT(BOOL blnPTT)
{
	// Returns TRUE if successful False otherwise

	if (blnLastPTT &&  !blnPTT)
		dttStartRTMeasure = Now;  // start a measurement on release of PTT.

	if (!RadioControl)
		if (blnPTT)
			SendCommandToHostQuiet("PTT TRUE");
		else
			SendCommandToHostQuiet("PTT FALSE");

	else
		RadioPTT(blnPTT);

	ZF_LOGD("[Main.KeyPTT]  PTT-%s", BoolString[blnPTT]);

	blnLastPTT = blnPTT;
	SetLED(0, blnPTT);
	wg_send_pttled(0, blnPTT);
	return TRUE;
}


static struct speed_struct
{
	int	user_speed;
	speed_t termios_speed;
} speed_table[] = {
	{300, B300},
	{600, B600},
	{1200, B1200},
	{2400, B2400},
	{4800, B4800},
	{9600, B9600},
	{19200, B19200},
	{38400, B38400},
	{57600, B57600},
	{115200, B115200},
	{-1, B0}
};



// GPIO access stuff for PTT on PI

#if defined(__ARM_ARCH) && defined(__linux__)

/*
	tiny_gpio.c
	2016-04-30
	Public Domain
*/
#include <stdio.h>
#include <unistd.h>
#include <stdint.h>
#include <string.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/types.h>

#define GPSET0 7
#define GPSET1 8

#define GPCLR0 10
#define GPCLR1 11

#define GPLEV0 13
#define GPLEV1 14

#define GPPUD 37
#define GPPUDCLK0 38
#define GPPUDCLK1 39

unsigned piModel;
unsigned piRev;

static volatile uint32_t  *gpioReg = MAP_FAILED;

#define PI_BANK (gpio>>5)
#define PI_BIT  (1<<(gpio&0x1F))

/* gpio modes. */

void gpioSetMode(unsigned gpio, unsigned mode)
{
	int reg, shift;

	reg   =  gpio/10;
	shift = (gpio%10) * 3;

	gpioReg[reg] = (gpioReg[reg] & ~(7<<shift)) | (mode<<shift);
}

int gpioGetMode(unsigned gpio)
{
	int reg, shift;

	reg   =  gpio/10;
	shift = (gpio%10) * 3;

	return (*(gpioReg + reg) >> shift) & 7;
}

// Values for pull-ups/downs off, pull-down and pull-up.

#define PI_PUD_OFF  0
#define PI_PUD_DOWN 1
#define PI_PUD_UP   2

void gpioSetPullUpDown(unsigned gpio, unsigned pud)
{
	*(gpioReg + GPPUD) = pud;

	usleep(20);

	*(gpioReg + GPPUDCLK0 + PI_BANK) = PI_BIT;

	usleep(20);

	*(gpioReg + GPPUD) = 0;

	*(gpioReg + GPPUDCLK0 + PI_BANK) = 0;
}

int gpioRead(unsigned gpio)
{
	if ((*(gpioReg + GPLEV0 + PI_BANK) & PI_BIT) != 0)
		return 1;
	else
		return 0;
}
void gpioWrite(unsigned gpio, unsigned level)
{
	if (level == 0)
		*(gpioReg + GPCLR0 + PI_BANK) = PI_BIT;
	else
		*(gpioReg + GPSET0 + PI_BANK) = PI_BIT;
}

void gpioTrigger(unsigned gpio, unsigned pulseLen, unsigned level)
{
	if (level == 0)
		*(gpioReg + GPCLR0 + PI_BANK) = PI_BIT;
	else
		*(gpioReg + GPSET0 + PI_BANK) = PI_BIT;

	usleep(pulseLen);

	if (level != 0)
		*(gpioReg + GPCLR0 + PI_BANK) = PI_BIT;
	else
		*(gpioReg + GPSET0 + PI_BANK) = PI_BIT;
}

// Bit (1<<x) will be set if gpio x is high.

uint32_t gpioReadBank1(void) {
	return (*(gpioReg + GPLEV0));
}
uint32_t gpioReadBank2(void) {
	return (*(gpioReg + GPLEV1));
}

// To clear gpio x bit or in (1<<x).

void gpioClearBank1(uint32_t bits) {
	*(gpioReg + GPCLR0) = bits;
}
void gpioClearBank2(uint32_t bits) {
	*(gpioReg + GPCLR1) = bits;
}

// To set gpio x bit or in (1<<x).

void gpioSetBank1(uint32_t bits) {
	*(gpioReg + GPSET0) = bits;
}
void gpioSetBank2(uint32_t bits) {
	*(gpioReg + GPSET1) = bits;
}

unsigned gpioHardwareRevision(void)
{
	static unsigned rev = 0;

	FILE * filp;
	char buf[512];
	char term;
	int chars=4;  // number of chars in revision string

	if (rev)
		return rev;

	piModel = 0;

	filp = fopen ("/proc/cpuinfo", "r");

	if (filp != NULL)
	{
		while (fgets(buf, sizeof(buf), filp) != NULL)
		{
			if (piModel == 0)
			{
				if (!strncasecmp("model name", buf, 10))
				{
					if (strstr (buf, "ARMv6") != NULL)
					{
						piModel = 1;
						chars = 4;
					}
					else if (strstr (buf, "ARMv7") != NULL)
					{
						piModel = 2;
						chars = 6;
					}
					else if (strstr (buf, "ARMv8") != NULL)
					{
						piModel = 2;
						chars = 6;
					}
				}
			}

			if (!strncasecmp("revision", buf, 8))
			{
				if (sscanf(buf+strlen(buf)-(chars+1),
					"%x%c", &rev, &term) == 2)
				{
					if (term != '\n')
						rev = 0;
				}
			}
		}

		fclose(filp);
	}
	return rev;
}

int gpioInitialise(void)
{
	int fd;

	piRev = gpioHardwareRevision();  // sets piModel and piRev

	fd = open("/dev/gpiomem", O_RDWR | O_SYNC) ;

	if (fd < 0)
	{
		fprintf(stderr, "failed to open /dev/gpiomem\n");
		return -1;
	}

	gpioReg = (uint32_t *)mmap(NULL, 0xB4, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);

	close(fd);

	if (gpioReg == MAP_FAILED)
	{
		fprintf(stderr, "Bad, mmap failed\n");
		return -1;
	}
	return 0;
}



#endif



int stricmp(const unsigned char * pStr1, const unsigned char *pStr2)
{
	unsigned char c1, c2;
	int  v;

	if (pStr1 == NULL)
	{
		if (pStr2)
			ZF_LOGW("stricmp called with NULL 1st param - 2nd %s ", pStr2);
		else
			ZF_LOGW("stricmp called with two NULL params");

		return 1;
	}


	do {
		c1 = *pStr1++;
		c2 = *pStr2++;
		// The casts are necessary when pStr1 is shorter & char is signed
		v = tolower(c1) - tolower(c2);
	} while ((v == 0) && (c1 != '\0') && (c2 != '\0') );

	return v;
}

char Leds[8]= {0};
unsigned int PKTLEDTimer = 0;

void SetLED(int LED, int State)
{
	// If GUI active send state

	Leds[LED] = State;
	SendtoGUI('D', Leds, 8);
}

void DrawTXMode(const char * Mode)
{
	unsigned char Msg[64];
	strcpy(Msg, Mode);
	SendtoGUI('T', Msg, strlen(Msg) + 1);  // TX Frame

}

void DrawTXFrame(const char * Frame)
{
	unsigned char Msg[64];
	strcpy(Msg, Frame);
	SendtoGUI('T', Msg, strlen(Msg) + 1);  // TX Frame
}

void DrawRXFrame(int State, const char * Frame)
{
	unsigned char Msg[64];

	Msg[0] = State;  // Pending/Good/Bad
	strcpy(&Msg[1], Frame);
	SendtoGUI('R', Msg, strlen(Frame) + 1);  // RX Frame
}
// mySetPixel() uses 3 bytes from Pixels per call.  So it must be 3 times the
// size of the larger of inPhases[0] or intToneMags/4. (intToneMags/4 is larger)
UCHAR Pixels[9108];
UCHAR * pixelPointer = Pixels;


// This data may be copied and pasted from the debug log file into the
// "Host Command" input box in the WebGui in developer mode to reproduce
// the constellation plot.
void LogConstellation() {
	char Msg[10000] = "CPLOT ";
	for (int i = 0; i < pixelPointer - Pixels; i++)
		snprintf(Msg + strlen(Msg), sizeof(Msg) - strlen(Msg), "%02X", Pixels[i]);
	ZF_LOGV("%s", Msg);
}


void mySetPixel(unsigned char x, unsigned char y, unsigned int Colour)
{
	// Used on Windows for constellation. Save points and send to GUI at end

	*(pixelPointer++) = x;
	*(pixelPointer++) = y;
	*(pixelPointer++) = Colour;
}
void clearDisplay()
{
	// Reset pixel pointer

	pixelPointer = Pixels;

}
void updateDisplay()
{
//	 SendtoGUI('C', Pixels, pixelPointer - Pixels);
}
void DrawAxes(int Qual, char * Mode)
{
	UCHAR Msg[80];
	SendtoGUI('C', Pixels, pixelPointer - Pixels);
	wg_send_pixels(0, Pixels, pixelPointer - Pixels);
	LogConstellation();
	pixelPointer = Pixels;

	sprintf(Msg, "%s Quality: %d", Mode, Qual);
	SendtoGUI('Q', Msg, strlen(Msg) + 1);
}
void DrawDecode(char * Decode)
{}
