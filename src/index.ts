import {
	AccountInfo,
	Commitment,
	ConfirmOptions,
	Connection,
	GetAccountInfoConfig,
	PublicKey,
	RpcResponseAndContext,
	SendOptions,
	Signer,
	Transaction,
	TransactionSignature,
	VersionedTransaction,
	SendTransactionError,
	GetBalanceConfig,
	GetMultipleAccountsConfig,
	GetLatestBlockhashConfig,
	BlockhashWithExpiryBlockHeight,
	SignatureStatusConfig,
	SignatureStatus,
	TransactionConfirmationStatus,
	LogsCallback,
	AccountChangeCallback,
	GetTransactionConfig,
	GetVersionedTransactionConfig,
	GetSlotConfig,
	TransactionError,
	TransactionConfirmationStrategy,
	SignatureResult,
	Blockhash,
	FeeCalculator,
} from "@solana/web3.js";
import { Provider, Wallet } from "@coral-xyz/anchor";
import {
	BanksClient,
	BanksTransactionResultWithMeta,
	Clock,
	ProgramTestContext,
} from "solana-bankrun";
import bs58 from "bs58";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { SuccessfulTxSimulationResponse } from "@coral-xyz/anchor/dist/cjs/utils/rpc";

type BankrunTransactionMetaNormalized = {
	logMessages: string[];
	err: TransactionError;
};

type BankrunTransactionRespose = {
	slot: number;
	meta: BankrunTransactionMetaNormalized;
};

interface ConnectionInterface
	extends Pick<
		Connection,
		| "getAccountInfo"
		| "getAccountInfoAndContext"
		| "getMinimumBalanceForRentExemption"
		| "getBalance"
		| "getLatestBlockhash"
		| "getRecentBlockhash"
		| "getMultipleAccountsInfo"
		| "getMultipleAccountsInfoAndContext"
		// | "getProgramAccounts"
		| "sendRawTransaction"
		| "getSignatureStatus"
		| "getSlot"
		| "confirmTransaction"
	> {
	getTransaction(
		signature: string,
		_rawConfig?: GetTransactionConfig | GetVersionedTransactionConfig,
	): Promise<BankrunTransactionRespose | null>;
}

class BankrunConnectionProxy implements ConnectionInterface {
	private readonly _banksClient: BanksClient;
	private readonly _context: ProgramTestContext;

	private _clock: Clock;
	private _transactionToMeta: Map<
		TransactionSignature,
		BanksTransactionResultWithMeta
	> = new Map();
	private _onLogCallbacks = new Map<number, LogsCallback>();
	private _onAccountChangeCallbacks = new Map<
		number,
		[PublicKey, AccountChangeCallback]
	>();

	constructor(banksClient: BanksClient, context: ProgramTestContext) {
		this._banksClient = banksClient;
		this._context = context;
	}

	async getAccountInfoAndContext(
		publicKey: PublicKey,
		commitmentOrConfig?: Commitment | GetAccountInfoConfig | undefined,
	): Promise<RpcResponseAndContext<AccountInfo<Buffer> | null>> {
		const accountInfoBytes = await this._banksClient.getAccount(
			publicKey,
			commitmentOrConfig as Commitment,
		);
		const res: RpcResponseAndContext<AccountInfo<Buffer> | null> = {
			context: { slot: Number(await this._banksClient.getSlot()) },
			value: null,
		};
		if (accountInfoBytes) {
			res.value = {
				...accountInfoBytes,
				data: Buffer.from(accountInfoBytes.data),
			};
		}
		return res;
	}

	async getAccountInfo(
		publicKey: PublicKey,
		commitmentOrConfig?: Commitment | GetAccountInfoConfig | undefined,
	): Promise<AccountInfo<Buffer> | null> {
		const accountInfoBytes = await this._banksClient.getAccount(
			publicKey,
			commitmentOrConfig as Commitment,
		);
		if (!accountInfoBytes) {
			return null;
		}
		return {
			...accountInfoBytes,
			data: Buffer.from(accountInfoBytes.data),
		};
	}

	async getMinimumBalanceForRentExemption(
		dataLength: number,
		commitment?: Commitment,
	): Promise<number> {
		const rent = await this._banksClient.getRent();
		return Number(rent.minimumBalance(BigInt(dataLength)));
	}

	async getBalance(
		publicKey: PublicKey,
		commitmentOrConfig?: Commitment | GetBalanceConfig,
	): Promise<number> {
		const balance = await this._banksClient.getBalance(publicKey);
		return Number(balance);
	}

	async getMultipleAccountsInfo(
		publicKeys: PublicKey[],
		commitmentOrConfig?: Commitment | GetMultipleAccountsConfig,
	): Promise<(AccountInfo<Buffer> | null)[]> {
		const accountInfos = [];

		for (const publicKey of publicKeys) {
			const accountInfo = await this.getAccountInfo(
				publicKey,
				commitmentOrConfig,
			);
			accountInfos.push(accountInfo);
		}

		return accountInfos;
	}

	async getMultipleAccountsInfoAndContext(
		publicKeys: PublicKey[],
		commitmentOrConfig?: Commitment | GetMultipleAccountsConfig,
	): Promise<RpcResponseAndContext<AccountInfo<Buffer>[]>> {
		const value = await this.getMultipleAccountsInfo(
			publicKeys,
			commitmentOrConfig,
		);
		return {
			context: { slot: Number(await this._banksClient.getSlot()) },
			value,
		};
	}

	/**
	 * Fetch all the accounts owned by the specified program id
	 *
	 * @return {Promise<Array<{pubkey: PublicKey, account: AccountInfo<Buffer>}>>}
	 */
	// async getProgramAccounts(
	// 	programId: PublicKey,
	// 	configOrCommitment: GetProgramAccountsConfig &
	// 		Readonly<{ withContext: true }>,
	// ): Promise<RpcResponseAndContext<GetProgramAccountsResponse>>;
	// // eslint-disable-next-line no-dupe-class-members
	// async getProgramAccounts(
	// 	programId: PublicKey,
	// 	configOrCommitment?: GetProgramAccountsConfig | Commitment,
	// ): Promise<GetProgramAccountsResponse>;
	// // eslint-disable-next-line no-dupe-class-members
	// async getProgramAccounts(
	// 	programId: PublicKey,
	// 	configOrCommitment?: GetProgramAccountsConfig | Commitment,
	// ): Promise<
	// 	| GetProgramAccountsResponse
	// 	| RpcResponseAndContext<GetProgramAccountsResponse>
	// > {
	// 	const res = {};

	// 	if ("error" in res) {
	// 		throw new SolanaJSONRPCError(
	// 			res.error,
	// 			`failed to get accounts owned by program ${programId.toBase58()}`,
	// 		);
	// 	}
	// 	return res.result;
	// }

	async getLatestBlockhash(
		commitmentOrConfig?: Commitment | GetLatestBlockhashConfig,
	): Promise<BlockhashWithExpiryBlockHeight> {
		const [blockhash, lastValidBlockHeight] =
			await this._banksClient.getLatestBlockhash(
				commitmentOrConfig as Commitment,
			);
		return {
			blockhash,
			lastValidBlockHeight: Number(lastValidBlockHeight),
		};
	}

	async getRecentBlockhash(commitment?: Commitment): Promise<{
		blockhash: Blockhash;
		feeCalculator: FeeCalculator;
	}> {
		const [blockhash] = await this._banksClient.getLatestBlockhash(commitment);
		return {
			blockhash,
			feeCalculator: {
				lamportsPerSignature: 5000, // const
			},
		};
	}

	async sendRawTransaction(
		rawTransaction: Buffer | Uint8Array | Array<number>,
		options?: SendOptions,
	): Promise<TransactionSignature> {
		const tx = Transaction.from(rawTransaction);
		// console.log(
		// 	"sendRawTransaction: ",
		// 	tx.serializeMessage().toString("base64"),
		// );
		const signature = await this.sendTransaction(tx);
		return signature;
	}

	async sendTransaction(tx: Transaction): Promise<TransactionSignature> {
		const banksTransactionMeta = await this._banksClient.tryProcessTransaction(
			tx,
		);
		if (banksTransactionMeta.result) {
			throw new Error(banksTransactionMeta.result);
		}
		const signature = bs58.encode(tx.signatures[0].signature);
		this._transactionToMeta.set(signature, banksTransactionMeta);
		let finalizedCount = 0;
		while (finalizedCount < 10) {
			const signatureStatus = (await this.getSignatureStatus(signature)).value
				.confirmationStatus;
			if (signatureStatus.toString() == '"finalized"') {
				finalizedCount += 1;
			}
		}

		// update the clock slot/timestamp
		// sometimes race condition causes failures so we retry
		try {
			await this._updateSlotAndClock();
		} catch (e) {
			await this._updateSlotAndClock();
		}

		if (this._onLogCallbacks.size > 0) {
			const transaction = await this.getTransaction(signature);

			const context = { slot: transaction.slot };
			const logs = {
				logs: transaction.meta.logMessages,
				err: transaction.meta.err,
				signature,
			};
			for (const logCallback of this._onLogCallbacks.values()) {
				logCallback(logs, context);
			}
		}

		for (const [
			publicKey,
			callback,
		] of this._onAccountChangeCallbacks.values()) {
			const accountInfo = await this.getParsedAccountInfo(publicKey);
			callback(accountInfo.value, accountInfo.context);
		}

		return signature;
	}

	async getSignatureStatus(
		signature: string,
		_config?: SignatureStatusConfig,
	): Promise<RpcResponseAndContext<null | SignatureStatus>> {
		const transactionStatus = await this._banksClient.getTransactionStatus(
			signature,
		);
		const slot = Number(await this._banksClient.getSlot());
		if (transactionStatus === null) {
			return {
				context: { slot },
				value: null,
			};
		}
		return {
			context: { slot },
			value: {
				slot: Number(transactionStatus.slot),
				confirmations: Number(transactionStatus.confirmations),
				err: transactionStatus.err,
				confirmationStatus:
					transactionStatus.confirmationStatus as TransactionConfirmationStatus,
			},
		};
	}

	/**
	 * There's really no direct equivalent to getTransaction exposed by SolanaProgramTest, so we do the best that we can here - it's a little hacky.
	 */
	async getTransaction(
		signature: string,
		_rawConfig?: GetTransactionConfig | GetVersionedTransactionConfig,
	): Promise<BankrunTransactionRespose | null> {
		const txMeta = this._transactionToMeta.get(
			signature as TransactionSignature,
		);
		if (txMeta === undefined) {
			return null;
		}
		const transactionStatus = await this._banksClient.getTransactionStatus(
			signature,
		);
		const meta: BankrunTransactionMetaNormalized = {
			logMessages: txMeta.meta.logMessages,
			err: txMeta.result,
		};
		return {
			slot: Number(transactionStatus.slot),
			meta,
		};
	}

	async getParsedAccountInfo(
		publicKey: PublicKey,
	): Promise<RpcResponseAndContext<AccountInfo<Buffer>>> {
		const accountInfoBytes = await this._banksClient.getAccount(publicKey);
		const slot = Number(await this._banksClient.getSlot());
		if (accountInfoBytes === null) {
			return {
				context: { slot },
				value: null,
			};
		}
		accountInfoBytes.data = Buffer.from(accountInfoBytes.data);
		const accountInfoBuffer = accountInfoBytes as AccountInfo<Buffer>;
		return {
			context: { slot },
			value: accountInfoBuffer,
		};
	}

	async getSlot(
		commitmentOrConfig?: Commitment | GetSlotConfig,
	): Promise<number> {
		const slot = await this._banksClient.getSlot();
		return Number(slot);
	}

	// TODO:
	async confirmTransaction(
		strategy: string | TransactionConfirmationStrategy,
		commitment?: Commitment,
	): Promise<RpcResponseAndContext<SignatureResult>> {
		const slot = Number(await this._banksClient.getSlot(commitment));
		return {
			context: { slot },
			value: {
				err: null,
			},
		};
	}

	private async _updateSlotAndClock() {
		const currentSlot = await this.getSlot();
		const nextSlot = BigInt(currentSlot + 1);
		this._context.warpToSlot(nextSlot);
		const currentClock = await this._banksClient.getClock();
		const newClock = new Clock(
			BigInt(nextSlot),
			currentClock.epochStartTimestamp,
			currentClock.epoch,
			currentClock.leaderScheduleEpoch,
			currentClock.unixTimestamp + BigInt(1),
		);
		this._context.setClock(newClock);
		this._clock = newClock;
	}
}

async function sendWithErr(
	tx: Transaction | VersionedTransaction,
	client: BanksClient,
) {
	const res = await client.tryProcessTransaction(tx);
	const maybeMeta = res.meta;
	const errMsg = res.result;
	if (errMsg !== null) {
		if (maybeMeta !== null) {
			const logs = maybeMeta.logMessages;
			throw new SendTransactionError(errMsg, logs);
		} else {
			throw new SendTransactionError(errMsg);
		}
	}
}

export class BankrunProvider implements Provider {
	wallet: Wallet;
	connection: Connection;
	publicKey: PublicKey;

	constructor(public context: ProgramTestContext, wallet?: Wallet) {
		this.wallet = wallet || new NodeWallet(context.payer);
		this.connection = new BankrunConnectionProxy(
			context.banksClient,
			context,
		) as unknown as Connection; // uh
		this.publicKey = this.wallet.publicKey;
	}

	async send?(
		tx: Transaction | VersionedTransaction,
		signers?: Signer[] | undefined,
		opts?: SendOptions | undefined,
	): Promise<string> {
		if ("version" in tx) {
			signers?.forEach((signer) => tx.sign([signer]));
		} else {
			tx.feePayer = tx.feePayer ?? this.wallet.publicKey;
			tx.recentBlockhash = (
				await this.context.banksClient.getLatestBlockhash()
			)[0];

			signers?.forEach((signer) => tx.partialSign(signer));
		}
		this.wallet.signTransaction(tx);

		let signature: string;
		if ("version" in tx) {
			signature = bs58.encode(tx.signatures[0]);
		} else {
			if (!tx.signature) throw new Error("Missing fee payer signature");
			signature = bs58.encode(tx.signature);
		}
		await this.context.banksClient.sendTransaction(tx);
		return signature;
	}

	async sendAndConfirm?(
		tx: Transaction | VersionedTransaction,
		signers?: Signer[] | undefined,
		opts?: ConfirmOptions | undefined,
	): Promise<string> {
		if ("version" in tx) {
			signers?.forEach((signer) => tx.sign([signer]));
		} else {
			tx.feePayer = tx.feePayer ?? this.wallet.publicKey;
			tx.recentBlockhash = (
				await this.context.banksClient.getLatestBlockhash()
			)[0];

			signers?.forEach((signer) => tx.partialSign(signer));
		}
		this.wallet.signTransaction(tx);

		let signature: string;
		if ("version" in tx) {
			signature = bs58.encode(tx.signatures[0]);
		} else {
			if (!tx.signature) throw new Error("Missing fee payer signature");
			signature = bs58.encode(tx.signature);
		}
		await sendWithErr(tx, this.context.banksClient);
		return signature;
	}

	async sendAll<T extends Transaction | VersionedTransaction>(
		txWithSigners: { tx: T; signers?: Signer[] | undefined }[],
		opts?: ConfirmOptions | undefined,
	): Promise<string[]> {
		const recentBlockhash = (
			await this.context.banksClient.getLatestBlockhash()
		)[0];

		const txs = txWithSigners.map((r) => {
			if ("version" in r.tx) {
				const tx: VersionedTransaction = r.tx;
				if (r.signers) {
					tx.sign(r.signers);
				}
				return tx;
			} else {
				const tx: Transaction = r.tx;
				const signers = r.signers ?? [];

				tx.feePayer = tx.feePayer ?? this.wallet.publicKey;
				tx.recentBlockhash = recentBlockhash;

				signers.forEach((kp) => {
					tx.partialSign(kp);
				});
				return tx;
			}
		});

		const signedTxs = await this.wallet.signAllTransactions(txs);
		const sigs: TransactionSignature[] = [];

		for (let k = 0; k < txs.length; k += 1) {
			const tx = signedTxs[k];
			const rawTx = tx.serialize();
			if ("version" in tx) {
				sigs.push(bs58.encode(tx.signatures[0]));
			} else {
				sigs.push(bs58.encode(tx.signature));
			}
			await sendWithErr(tx, this.context.banksClient);
		}
		return sigs;
	}

	async simulate(
		tx: Transaction | VersionedTransaction,
		signers?: Signer[] | undefined,
		commitment?: Commitment | undefined,
		includeAccounts?: boolean | PublicKey[] | undefined,
	): Promise<SuccessfulTxSimulationResponse> {
		if (includeAccounts !== undefined) {
			throw new Error("includeAccounts cannot be used with BankrunProvider");
		}
		if ("version" in tx) {
			signers?.forEach((signer) => tx.sign([signer]));
		} else {
			tx.feePayer = tx.feePayer ?? this.wallet.publicKey;
			tx.recentBlockhash = (
				await this.context.banksClient.getLatestBlockhash()
			)[0];

			signers?.forEach((signer) => tx.partialSign(signer));
		}
		const rawResult = await this.context.banksClient.simulateTransaction(
			tx,
			commitment,
		);
		const returnDataRaw = rawResult.meta.returnData;
		const b64 = Buffer.from(returnDataRaw.data).toString("base64");
		const data: [string, "base64"] = [b64, "base64"];
		const returnData = {
			programId: returnDataRaw.programId.toString(),
			data,
		};
		return {
			logs: rawResult.meta.logMessages,
			unitsConsumed: Number(rawResult.meta.computeUnitsConsumed),
			returnData,
		};
	}
}
