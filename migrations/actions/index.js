/* eslint-disable no-console */
const BigNumber = require('bignumber.js')
const argv = require('../helpers/arguments')

const migrationHelpers = require('../helpers')

const index = async (deployer, accounts, contracts, web3, network) => {
  const {
    brickblockToken,
    constants: {
      oneWeekInSec,
      twoWeeksInSec,
      oneHundredThousandEuroInCents,
      oneHundredThousandTokensInWei
    },
    exchangeRates,
    general: {
      addContractsToRegistry,
      getEtherBalance,
      unixTimeWithOffsetInSec,
      sendTransaction
    },
    deployment: { deployContracts },
    poaManager,
    whitelist,
    statistics,
    ownerManagement: { transferOwnershipOfAllContracts }
  } = migrationHelpers

  const owner = accounts[0]
  const broker = accounts[1]
  const custodian = accounts[2]
  const contributors = accounts.slice(4, 6)
  const whitelistedInvestor = accounts[3]
  const ownerStartEtherBalance = await getEtherBalance(owner)
  const brokerStartEtherBalance = await getEtherBalance(broker)
  let ownerPreEtherBalance,
    ownerPostEtherBalance,
    brokerPostEtherBalance,
    addToRegistryGasCost,
    setFiatRateGasCost,
    finalizeBbkCrowdsaleGasCost,
    addBrokerGasCost,
    deployPoaTokenGasCost,
    whitelistAddressGasCost,
    changeOwnerGasCost
  const useStub = network.search('dev') > -1

  const actions = {
    register: argv.register,
    setRate: argv.setRate,
    finalizeBbk: argv.finalizeBbk,
    addBroker: argv.addBroker,
    deployPoa: argv.deployPoa,
    addToWhiteList: argv.addToWhiteList
  }

  let hasParams = false
  Object.keys(actions).forEach(key => {
    hasParams = hasParams || actions[key]
  })

  if (argv.all) {
    Object.keys(actions).forEach(key => {
      actions[key] = true
    })
  }

  /*
   * Get deployed contract instances first
   */
  ownerPreEtherBalance = await getEtherBalance(owner)
  const instances = await deployContracts(deployer, accounts, contracts, {
    useExpStub: useStub,
    useExistingContracts: argv.useExistingContracts,
    network
  })
  ownerPostEtherBalance = await getEtherBalance(owner)
  const deployContractsGasCost = ownerPreEtherBalance.sub(ownerPostEtherBalance)

  if (actions.register) {
    /*
    * Add contract instances to our contract registry
    */
    ownerPreEtherBalance = await getEtherBalance(owner)
    await addContractsToRegistry(instances, { from: owner })
    ownerPostEtherBalance = await getEtherBalance(owner)
    addToRegistryGasCost = ownerPreEtherBalance.sub(ownerPostEtherBalance)
  }

  if (actions.setRate) {
    /*
    * Set ETH <> Fiat exchange rate in our oracle
    */
    ownerPreEtherBalance = await getEtherBalance(owner)
    await exchangeRates.setFiatRate(
      instances.ExchangeRates,
      instances.ExchangeRateProvider,
      {
        currencyName: 'EUR',
        queryString:
          'json(https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=EUR).EUR',
        callIntervalInSec: 60,
        callbackGasLimit: 1500000,
        useStub
      },
      { from: owner }
    )
    ownerPostEtherBalance = await getEtherBalance(owner)
    setFiatRateGasCost = ownerPreEtherBalance.sub(ownerPostEtherBalance)
  }

  if (actions.finalizeBbk) {
    /*
    * Finalize BBK crowdsale and distribute tokens to accounts[4-6]
    */
    ownerPreEtherBalance = await getEtherBalance(owner)
    await brickblockToken.finalizeBbkCrowdsale(
      instances.BrickblockToken,
      {
        fountainAddress: instances.BrickblockAccount.address,
        contributors,
        tokenAmountPerContributor: new BigNumber(100e18),
        network
      },
      { from: owner }
    )
    ownerPostEtherBalance = await getEtherBalance(owner)
    finalizeBbkCrowdsaleGasCost = ownerPreEtherBalance.sub(
      ownerPostEtherBalance
    )
  }

  if (actions.addBroker) {
    /*
    * Add broker to list of active brokers in PoaManager
    */
    ownerPreEtherBalance = await getEtherBalance(owner)
    await poaManager.addBroker(
      instances.PoaManager,
      { broker },
      { from: owner }
    )
    ownerPostEtherBalance = await getEtherBalance(owner)
    addBrokerGasCost = ownerPreEtherBalance.sub(ownerPostEtherBalance)
  }

  if (actions.deployPoa) {
    /*
    * Deploy new POA token from the previously added broker address
    */
    const brokerPreEtherBalance = await getEtherBalance(broker)
    if (brokerPreEtherBalance.lt('3.25e16')) {
      await sendTransaction({
        from: owner,
        to: broker,
        value: new BigNumber(3.25e16)
      })
    }

    await poaManager.deployPoa(
      instances.PoaManager,
      {
        name: 'Local Testnet Token',
        symbol: 'BBK-RE-DE123',
        fiatCurrency: 'EUR',
        custodian,
        totalSupply: oneHundredThousandTokensInWei,
        // startTimeForEthFundingPeriod needs a little offset so that it isn't too close to `block.timestamp` which would fail
        startTimeForEthFundingPeriod: unixTimeWithOffsetInSec(600),
        durationForEthFundingPeriod: oneWeekInSec,
        durationForActivationPeriod: twoWeeksInSec,
        fundingGoalInCents: oneHundredThousandEuroInCents
      },
      { from: broker }
    )
    brokerPostEtherBalance = await getEtherBalance(broker)
    deployPoaTokenGasCost = brokerPreEtherBalance.sub(brokerPostEtherBalance)
  }

  if (actions.addToWhiteList) {
    /*
    * Whitelist accounts[4] to be able to buy POA tokens in platform
    */
    ownerPreEtherBalance = await getEtherBalance(owner)
    await whitelist.addAddress(
      instances.Whitelist,
      {
        investor: whitelistedInvestor
      },
      { from: owner }
    )
    ownerPostEtherBalance = await getEtherBalance(owner)
    whitelistAddressGasCost = ownerPreEtherBalance.sub(ownerPostEtherBalance)
  }

  if (argv.changeOwner) {
    /*
    * Used for changing ownership of all contracts to the real owner 
    * Usually used on mainnet deployment
    */
    ownerPreEtherBalance = await getEtherBalance(owner)

    const newOwner = process.env.NEW_OWNER
    await transferOwnershipOfAllContracts(instances, owner, newOwner)
    ownerPostEtherBalance = await getEtherBalance(owner)
    changeOwnerGasCost = ownerPreEtherBalance.sub(ownerPostEtherBalance)
  }

  /*
   * Display gas cost for deploying full ecosystem
   */
  ownerPostEtherBalance = await getEtherBalance(owner)
  brokerPostEtherBalance = await getEtherBalance(broker)
  const totalGasCost = ownerStartEtherBalance
    .sub(ownerPostEtherBalance)
    .add(brokerStartEtherBalance.sub(brokerPostEtherBalance))

  statistics.showStatistics(
    {
      deployContractsGasCost,
      addToRegistryGasCost,
      finalizeBbkCrowdsaleGasCost,
      setFiatRateGasCost,
      addBrokerGasCost,
      deployPoaTokenGasCost,
      whitelistAddressGasCost,
      changeOwnerGasCost,
      totalGasCost
    },
    {
      web3,
      network
    }
  )
}

module.exports = index