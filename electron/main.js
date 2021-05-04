const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const isDev = require('electron-is-dev');   
const path = require('path');
const dnssd = require('dnssd2');
const got = require('got')
const fs = require('fs')
const open = require('open')

var FormData = require('form-data')
var sha256 = require('sha256-file')

let mainWindow;

//MDNS
const mdnsBrowser = dnssd.Browser(dnssd.tcp('epicminer'))
    .on('serviceUp', service => {
        addMinerMDNS(service.addresses, service.port);
    })
    .start();

var miners = [];
var listenerType = 'loading' // listener type corresponds to tabs

function minerAlreadyFound(ipport) {
    var contained = false;
    miners.forEach((m) => {
        if (m.ip === ipport.toString()) {
            contained = true;
        }
    });
    return contained;
}

function addMinerMDNS(addresses, port){
    var ipport = [];
    addresses.forEach((addr)=>{
        ipport.push(addr+':'+port);
    });
    if (!minerAlreadyFound(ipport)) {
        console.log('Miner MDNS found: ' + addresses.toString());
        ipport.forEach((el) => {
            miners.push({
                ip: el,
                summary: {
                    status: 'empty'
                },
                history: {
                    status: 'empty'
                }
            });
        });
    }
}

async function getLatestRelease(){
    
        const data = await got('https://api.github.com/repos/epicblockchain/epic-miner/releases').json();
        let latestRelease = {
            major: -1,
            minor: -1,
            patch: -1
        };
        
        data.forEach(release=>{
            let arr = release.tag_name.split('.');
            mr = {
                major: arr[0],
                minor: arr[1],
                patch: arr[2]
            };
            if (mr.major > latestRelease.major) {
                latestRelease = mr;
            } else if (mr.major === latestRelease.major
                && mr.minor > latestRelease.minor)
            {
                latestRelease = mr;
            } else if (mr.major === latestRelease.major
                && mr.minor === latestRelease.minor
                && mr.patch > latestRelease.patch)
            {
                latestRelease = mr;
            }
        })

        return latestRelease;
}

function getOldestRelease(){
    var oldestRelease = {
        major: Infinity,
        minor: Infinity,
        patch: Infinity
    }
    miners.forEach(m=>{
        if (m.summary.status === 'completed') {
            mArr = m.summary.data.Software.substring(12);
            mArr = mArr.split('.');
            mr = {
                major: mArr[0],
                minor: mArr[1],
                patch: mArr[2]
            };
            if (oldestRelease.major === null){
                oldestRelease = mr;
            } else {
                if (mr.major < oldestRelease.major){
                    oldestRelease = mr;
                } else if (mr.major === oldestRelease.major
                    && mr.minor < oldestRelease.minor)
                {
                    oldestRelease = mr;
                } else if (mr.major === oldestRelease.major
                    && mr.minor === oldestRelease.minor
                    && mr.patch < oldestRelease.patch)
                {
                    oldestRelease = mr;
                }
            }
        }
    })
    return oldestRelease;
}

function newReleaseNotification(newestRelease){
    mainWindow.webContents.send('new-releases', 'v' + newestRelease.major + '.' + newestRelease.minor + '.' + newestRelease.patch);
}
 
function createWindow() {
    mainWindow = new BrowserWindow({
        width:1536,
        height:864,
        show: false,
        webPreferences: {
            nodeIntegration: true
        },
        icon: __dirname + '/icon/512x512.png'
    });
    if (!isDev) {
        mainWindow.setMenu(null);
    }
    const startURL = isDev ? 'http://localhost:3000' : `file://${path.join(__dirname, '../build/index.html')}`;
 
    mainWindow.loadURL(startURL);
 
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    mainWindow.webContents.on('did-finish-load', ()=>{
        mainWindow.webContents.send('update-miner-ips', miners);
        
        const IpcInterval = 1000 + 500*miners.length;
        setInterval(sendData, IpcInterval) 

        //releases notif
        setTimeout(function(){
            var latestRelease = getLatestRelease();
            var oldestRelease = getOldestRelease();

            latestRelease.then(function(latestRelease){
                if (latestRelease.major > oldestRelease.major) {
                    newReleaseNotification(latestRelease);
                } else if (latestRelease.minor > oldestRelease.minor
                    &&  latestRelease.major === oldestRelease.minor)
                {
                    newReleaseNotification(latestRelease);
                } else if (latestRelease.patch > oldestRelease.patch
                    && latestRelease.major === oldestRelease.major
                    && latestRelease.patch === oldestRelease.patch)
                {
                    newReleaseNotification(latestRelease);
                }

            }).catch(err=>{
                console.log(err);
            })

        }, 8000); //8 seconds to check for oldest version on network
    });
}
app.on('ready', createWindow);

function getBlackListedHostnames(){
    let data;
    try {
        data = fs.readFileSync(path.join(getAppDataPath(), 'blacklist_hostnames.txt'));
    } catch (err) {
        console.log('no blacklist_hostnames.txt found');
        return
    }
    const fileData = data.toString()
    const hostnames = fileData.split('\n').slice(0, -1)
    return hostnames;
}

function removeBlackListedHostnames(){
    let data;
    try {
        data = fs.readFileSync(path.join(getAppDataPath(), 'blacklist_hostnames.txt'));
    } catch (err) {
        console.log('no blacklist_hostnames.txt found');
        return
    }
    const fileData = data.toString()
    const hostnames = fileData.split('\n').slice(0, -1)
    miners = miners.filter(m => {
        if (m.summary.status === 'empty') {
            return true;
        }
        if (hostnames.includes(m.summary.data.Hostname)) {
            return false;
        } else {
            return true;
        }
    });
}

let intervalTime = 5000;
let intervalTimeHistory = 5000;
//Accessing miner api
let summaryTimer = setInterval(()=>{
    //remove blacklisted miners
    removeBlackListedHostnames();
    //continue
    const len = miners.length;
    for (let i = 0; i < len; i++) {
        (async ()=>{
            try {
                    const response = await got('http://' + miners[i].ip + '/summary', {
                        responseType: 'json',
                        timeout: 5000
                    });
                    miners[i].summary.data = response.body;
                    miners[i].summary.status = 'completed';
                    //store some historical data
                    if (miners[i].history.status = 'completed') {
                        if (miners[i].rebooting
                            && ( Date.now() - miners[i].rebootTime > 30000) // must have been 30 seconds since starting the reboot to unreboot
                        ){
                            miners[i].rebooting = false;
                        }

                        //append to history
                        if (miners[i].history.status === 'completed'
                            && response.body['Session']['LastAverageMHs']
                            && response.body['Session']['LastAverageMHs']['Timestamp'] > miners[i].history.lastSeenTimestamp
                        ) {
                            miners[i].history.lastSeenTimestamp = response.body['Session']['LastAverageMHs']['Timestamp'];
                            miners[i].history.data.History.push({
                                "Hashrate": response.body["Session"]["LastAverageMHs"]['Hashrate'],
                                "Timestamp": response.body['Session']['LastAverageMHs']['Timestamp']
                            });

                            //trim to last 48 hours
                            if (miners[i].history.data.History.length > 48 || true) {
                                const oldHistory = miners[i].history.data.History;
                                miners[i].history.data.History = oldHistory.slice(-48);
                            }

                        }
                    }
                } catch (err) {
                    try {
                        miners[i].summary.data = null;
                        miners[i].summary.status = 'error'
                    } catch (err) {
                        console.log('error, miner was removed during summary request');
                        console.log('or');
                        console.log(err);
                    }
                }
        })();
    }

}, intervalTime)

let historyTimer = setInterval(()=>{
    const len = miners.length;
    for (let i = 0; i < len; i++) {
        if (miners[i].history.status === 'empty') {
            (async ()=>{
                try {
                    const response = await got('http://' + miners[i].ip + '/history', {
                        responseType: 'json',
                        timeout: 5000
                    });
                    miners[i].history.data = response.body;
                    miners[i].history.status = 'completed';
                    if (response.body['History'].length){
                        miners[i].history.lastSeenTimestamp = response.body['History'][response.body['History'].length-1]['Timestamp'];
                    } else {
                        miners[i].history.lastSeenTimestamp = 0;
                    }
                } catch (err) {
                    miners[i].history.data = null;
                    miners[i].history.status = 'error'
                }
            })();

        }
    }
}, intervalTimeHistory);

function calculateAverages(miner){
    let averages = {
        "15min": {
            hashrate: 0,
            valid: false
        },
        "1hr": {
            hashrate: 0,
            valid: false
        },
        "6hr": {
            hashrate: 0,
            valid: false
        },
        "24hr": {
            hashrate: 0,
            valid: false
        }
    }
    if (miner.summary.status === 'completed'){
        try {
            averages["15min"].hashrate = miner.summary.data["Session"]["Average MHs"];
            averages["15min"].valid = true;
        } catch (e) {
            console.log(e);
        }
    }
    
    let minerHistoryLength = null;
    try {
        minerHistoryLength = miner.history.data.History.length
    } catch (e) {
        return averages;
    }

    if (miner && (miner.history.status === 'completed' && minerHistoryLength > 0)){
        let reverseHistory = null;
        try {
            const historyClone = miner.history.data.History.map(el => {
                return el.Hashrate;
            });
            //24 elements from the back in reverse, a better way might be to use the timestamp on the history object
            reverseHistory = historyClone.reverse().slice(0, 24);
        } catch (e) {
            console.log(e);
            return averages;
        }
        if (reverseHistory.length >= 1){
            try {
                averages["1hr"].hashrate = reverseHistory[0];
                averages["1hr"].valid = true;
            } catch (e) {
                console.log(e);
            }
        }
        if (reverseHistory.length >= 6){
            try {
                averages["6hr"].hashrate = reverseHistory.slice(0,6).reduce((a,b) => a+b) / 6;
                averages["6hr"].valid = true;
            } catch (e) {
                console.log(e);
            }
        }
        if (reverseHistory.length >= 24){
            try {
                averages["24hr"].hashrate = reverseHistory.slice(0,24).reduce((a,b) => a+b) / 24;
                averages["24hr"].valid = true;
            } catch (e) {
                console.log(e);
            }
        }
    }
    return averages;
}

//dashboard

function getDashboardData(){

    let totalMHs = 0;
    let accepted = 0;
    let rejected = 0;
    let activeMiners = 0;
    let pools = [];
    let lastAcceptedShare = 0;
    let lastAcceptedShareString = "N/A"
    let averageDifficulty = 0;
    miners.forEach(m => {
        if (m.summary.status == 'completed') {
            totalMHs += m.summary.data["Session"]["Average MHs"];
            accepted += m.summary.data["Session"]["Accepted"]
            rejected += m.summary.data["Session"]["Rejected"]
            averageDifficulty += m.summary.data["Session"]["Difficulty"]
            activeMiners++;
            let maybeLast = m.summary.data["Session"]["Last Accepted Share Timestamp"];
            if (maybeLast > lastAcceptedShare){
                lastAcceptedShare = maybeLast;
                lastAcceptedShareString = new Date(lastAcceptedShare * 1000).toString();
            }
            pool = m.summary.data["Stratum"]["Current Pool"]
            if (!pools.includes(pool)) {
                pools.push(pool);
            }
        }
    })
    let poolLength = pools.length;
    pools = pools.join(', ');
    averageDifficulty /= miners.length
    averageDifficulty = Math.round(averageDifficulty)

    let dashboardData = {
        card1: {
            heading: "Total Hashrate (TH/s)",
            content: Math.round(totalMHs / 10000) / 100
        },
        card2: {
            heading: "Accepted / Rejected",
            content: accepted.toString() + ' / ' + rejected.toString()
        },
        card3: {
            heading: "Active Miners",
            content: activeMiners + ' / ' + miners.length
        },
        card4: {
            heading: (poolLength > 1) ? "Pools" : "Pool",
            content: pools || 'N/A'
        },
        card5: {
            heading: "Average Difficulty",
            content: averageDifficulty
        },
        card6: {
            heading: "Last Accepted Share",
            content: lastAcceptedShareString
        },
    }
    
    return dashboardData;
}

ipcMain.on('get-dashboard', (event, arg) => {
    listenerType = 'dashboard';
    const dashboardData = getDashboardData()
    event.reply('get-dashboard-reply', dashboardData)
})

function getChartData() {
    let chartDataObj = {};
    //historical data
    miners.forEach(miner=>{
        if (miner.history.status === 'completed') {
            try {
                miner.history.data.History.forEach((el)=>{
                    if (!(el.Timestamp in chartDataObj)){
                        chartDataObj[el.Timestamp] = el.Hashrate;
                    } else {
                        chartDataObj[el.Timestamp] += el.Hashrate;
                    }
                });
            } catch (e) {
                console.log('Something wrong in electron main. Probably a empty miner history race condition');
            }
        }
    });
    let chartData = [];
    for (const prop in chartDataObj) {
        chartData.push({
            time: new Date(prop * 1000),
            hashrate: chartDataObj[prop] / 1000000
        })
    }
    return chartData;
}

//chart
ipcMain.on('get-chart', (event, arg) => {
    listenerType = 'chart';
    event.reply('get-chart-reply', getChartData());
});

//table
ipcMain.on('get-table', (event, arg) => {
    listenerType = 'table';
    event.reply('get-table-reply', {
        minerData: miners.map(miner => {
                return {
                    ip: miner.ip,
                    summary: miner.summary,
                    rebooting: miner.rebooting || false,
                    averageHRs: calculateAverages(miner)
                }
            }),
        blacklist: getBlackListedHostnames()
    });
});

//settings
ipcMain.on('get-settings', (event, arg) => {
    listenerType = 'settings'
    event.reply('get-settings-reply', miners.map(miner => {
        return {
            ip: miner.ip,
            summary: miner.summary,
            rebooting: miner.rebooting || false
        }
    }));
})

function getAppDataPath() {
    switch (process.platform) {
        case "darwin": {
            return path.join(process.env.HOME, "Library", "Application Support", "ePIC-Dashboard");
        }
        case "win32": {
            return path.join(process.env.APPDATA, "ePIC-Dashboard");
        }
        case "linux": {
            return path.join(process.env.HOME, ".ePIC-Dashboard");
        }
        default: {
            console.log("Unsupported platform!");
            process.exit(1);
        }
    } 
}

function saveMiners(){
    let minersString = '';
    miners.forEach(m => {
        minersString += m.ip + '\n';
    })

    fs.mkdir(getAppDataPath(), {recursive: true}, (err) => {
        console.log(err);
    })

    fs.writeFile(path.join(getAppDataPath(), 'ipaddr.txt'), minersString, function (err) {
        if (err) {
            console.log(err);
            throw err;
        }
        console.log('Saved miners to ' + path.join(getAppDataPath(), 'ipaddr.txt'))
        mainWindow.webContents.send('toast', {
            type: 'good',
            message: 'Saved miners'
        });
    })
}

//add new miner
ipcMain.on('add-new-miners', (event, arg) => {
    
    for (var i = 0; i < arg.length; i++) {
        let included = miners.find(miner => miner.ip === arg[i]);
        if (!(included)) {
            mainWindow.webContents.send('toast', {
                type: 'good',
                message: 'Miner added'
            })

            miners.push({
                ip: arg[i],
                summary: {
                    status: 'empty',
                    data: null
                },
                history: {
                    status: 'empty',
                    data: null
                }
            })
            console.log('Added miner ' + arg[i]);
        } else {
            mainWindow.webContents.send('toast', {
                type: 'warning',
                message: 'Miner already being tracked'
            })
        }
    }
    saveMiners();
});

//load previous miners
ipcMain.on('load-previous-miners', (event, arg) => {
    fs.readFile(path.join(getAppDataPath(), 'ipaddr.txt'), (err, data) => {
        if (err) {
            mainWindow.webContents.send('toast', {
                type: 'bad',
                message: 'No miners saved'
            });
            console.log('ipaddr.txt not found')
            return
        }
        const fileData = data.toString()
        const ips = fileData.split('\n')
        ips.forEach(newIP => {
            if (newIP) {
                const included = miners.find(miner => miner.ip === newIP);
                if (!included) {
                    miners.push({
                        ip: newIP,
                        summary: {
                            status: 'empty',
                            data: null
                        },
                        history: {
                            status: 'empty',
                            data: null
                        }
                    })
                    console.log('Added miner ' + newIP)
                } else {
                    console.log('miner already included')
                }
            }
        });

        mainWindow.webContents.send('toast', {
            type: 'good',
            message: 'Added saved miners'
        });

        console.log('TODO reply if successful')
    })
})

ipcMain.on('save-current-miners', (event, arg) => {
    saveMiners();
})

ipcMain.on('remove-miners', (event, arg) => {
    arg.forEach(removeIp => {
        let i = miners.findIndex( m => m.ip === removeIp);
        let removedIP = miners.splice(i, 1)[0].ip;
        console.log('removed: ' + removedIP)
        mainWindow.webContents.send('toast', {
            type: 'good',
            message: 'Removed ' + removedIP + ' from the dashboard'
        });
    });
    saveMiners();
})

function successMessageFromEndpoint(endpoint, ip){
    if (endpoint === '/pool') {
        return ip + ' pool updated';
    } else if (endpoint === '/login') {
        return ip + ' wallet updated';
    } else if (endpoint === '/mode') {
        return ip + ' is changing operating mode';
    } else if (endpoint === '/id') {
        return ip + ' will have a unique id appended to its worker name';
    } else if (endpoint === '/password') {
        return ip + ' password changed';
    } else if (endpoint === '/update') {
        return ip + ' updating firmware';
    } else if (endpoint === '/reboot') {
        return ip + ' is rebooting';
    } else if (endpoint === '/hwconfig') {
        return ip + ' is recalibrating';
    } else {
        return 'Success!';
    }
}

function postJSONtoIPs(ips, endpoint, obj){
    const len = ips.length;
    for (var i = 0; i < len ; i++) {
        (async () => {
            try {
                let idx = i;
                let responseBody;
                const rebootingEndpoint = (endpoint === '/mode' || endpoint === '/hwconfig' || endpoint === '/reboot');
                try {
                    const {body} = await got.post('http://' + ips[i] + endpoint, {
                        json: obj,
                        timeout: 5000, //5 seconds
                        responseType: 'json'
                    });
                    responseBody = body;
                } catch (err) {
                    console.log(err)
                }

                if (responseBody.result) {
                    mainWindow.webContents.send('toast', {
                        type: 'good',
                        message: successMessageFromEndpoint(endpoint, ips[idx])
                    });
                    if (rebootingEndpoint) {
                        setRebooting(ips[idx]);
                    }
                } else {
                    mainWindow.webContents.send('toast', {
                        type: 'bad',
                        message: ips[idx] + ' ' + ((responseBody && responseBody.error) || responseBody)
                    })
                }
            } catch (error) {
                console.log(error)
                mainWindow.webContents.send('toast', {
                    type: 'bad',
                    message: ips[idx] + ' ' + error
                })
            }

        })();

    }
}

function setRebooting(testIp) {
    const idx = miners.findIndex(m => m.ip === testIp)
    if (idx === -1) {
        console.log('unknown miner ip to set to rebooting')
        return;
    }
    miners[idx].rebooting = true;
    miners[idx].rebootTime = Date.now();
}

function postFormToIPs(ips, endpoint, password, checksum, keepsettings, filepath){
    const len = ips.length;
    for (let i = 0; i < len; i++) {
        ( async () => {
            var f = new FormData();
            f.append('password'     , password);
            f.append('checksum'     , checksum);
            f.append('keepsettings' , keepsettings);
            f.append('swupdate.swu' , fs.createReadStream(filepath));
            
            let responseBody;
            try {
                const { body } = await got.post('http://' + ips[i] + endpoint, {
                    body: f,
                    responseType: 'json',
                    timeout: 7200000 // 2hr
                }).catch(err => {
                    console.log(err)
                })
                responseBody = body;
            } catch (err) {
                console.log(err)
            } //TODO despite this handling got still have an uncaught exception
            

            if (responseBody && responseBody.result) {
                mainWindow.webContents.send('toast', {
                    type: 'good',
                    message: ips[i] + ' is now updating'
                });
                setRebooting(ips[i]);
            } else if (responseBody && responseBody.error) {
                mainWindow.webContents.send('toast', {
                    type: 'bad',
                    message: ips[i] + ' ' + responseBody.error
                })
            } else {
                mainWindow.webContents.send('toast', {
                    type: 'bad',
                    message: ips[i] + ' Something went wrong. Try again later if the miner is restarting.'
                })
            }
        })();
    }
    mainWindow.webContents.send('done-firmware-job')
}

//form dialog
ipcMain.on('get-filepath', (event, arg) => {
    dialog.showOpenDialog({
        filters: [
            { name: '.swu files', extensions: ['swu'] }
        ],
        properties: ['openFile']
    }).then((args) => {
        if (!args.canceled) {
            event.reply('get-filepath-reply', args.filePaths[0])
        }
    }).catch(error => {
        console.log('ipc filepath error')
        console.log(error)
    })
})

//posts
ipcMain.on('post-settings', (event, arg) => {
    
    const len = arg.state.miners.length;
    var postIPs = [];
    for (var i = 0; i < len; i++) {
        if (arg.state.miners[i].isChecked) {
            postIPs.push(arg.state.miners[i].ip)
        }
    }

    if (arg.tab === 'mining-pool') {
        const obj = {
            "param": arg.state.miningPool,
            "password": arg.state.password
        }
        postJSONtoIPs(postIPs, '/pool', obj)
    } else if (arg.tab === 'wallet-address') {
        const obj = {
            "param": {
                login: arg.state.walletAddress + '.' + arg.state.workerName,
                password: 'x'
            },
            "password": arg.state.password
        }
        postJSONtoIPs(postIPs, '/login', obj)
    } else if (arg.tab === 'operating-mode') {
        const obj = {
            "param": arg.state.operatingMode,
            "password": arg.state.password
        }
        postJSONtoIPs(postIPs, '/mode', obj)
    } else if (arg.tab === 'unique-id') {
        const obj = {
            "param": arg.state.appendUniqueID,
            "password": arg.state.password
        }
        postJSONtoIPs(postIPs, '/id', obj)
    } else if (arg.tab === 'new-password') {
        if (arg.state.newPassword === arg.state.verifyPassword) {
            const obj = {
                "param": arg.state.newPassword,
                "password": arg.state.password
            }
            postJSONtoIPs(postIPs, '/password', obj)
        } else {
            mainWindow.webContents.send('toast', {
                type: 'bad',
                message: 'Passwords did not match'
            })
        }
    } else if (arg.tab === 'firmware') {
        postFormToIPs(postIPs,
            '/update',
            arg.state.password,
            sha256(arg.state.swuFilepath),
            arg.state.keepSettings.toString(),
            arg.state.swuFilepath
        )
    } else if (arg.tab === 'reboot') {
        const obj = {
            "param": arg.state.rebootDelay,
            "password": arg.state.password
        }
        postJSONtoIPs(postIPs, '/reboot', obj)
    } else if (arg.tab === 'hwconfig') {
        const obj = {
            "param": true,
            "password": arg.state.password
        }
        postJSONtoIPs(postIPs, '/hwconfig', obj)
    } else {
        console.log('Error: unknown settings tab apply value');
    }
    

})

function sendData(){
    //handle a race condition with the window closing and still trying to send data to it
    if (mainWindow.webContents === null){
        console.log('trying to send data when webcontents has closed or has not been init');
        return;
    }

    if ( (listenerType === 'loading' || listenerType === 'table') && miners.length) {
        mainWindow.webContents.send('stop-loading')
    } else if (listenerType === 'dashboard') {
        mainWindow.webContents.send('get-dashboard-reply', getDashboardData())
    } else if (listenerType === 'chart') {
        //chart doesnt need to be updated(or at least not very often) to maintain scrollbar
        //mainWindow.webContents.send('get-chart-reply', getChartData());
    } else if (listenerType === 'settings') {
        mainWindow.webContents.send('get-settings-reply', miners.map(miner => {
            return {
                ip: miner.ip,
                summary: miner.summary,
                rebooting: miner.rebooting || false
            }
        }))
    }
    //always send table data now since we had to hack persistnce
    //todo: fix performance
    mainWindow.webContents.send('get-table-reply', {
            minerData: miners.map(miner => {
                    return {
                        ip: miner.ip,
                        summary: miner.summary,
                        rebooting: miner.rebooting || false,
                        averageHRs: calculateAverages(miner)
                    }
                }),
            blacklist: getBlackListedHostnames()
    });
}

ipcMain.on('data-dump', () => {
    console.log('Dumping data');
    dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory']
    }).then((arg)=>{
        if (!arg.canceled){
            let privateMiners = miners;
            console.log(miners);
            console.log(privateMiners);
            const len = miners.length;
            for (let i = 0; i < len; i++) {
                if (privateMiners[i].sumary) {
                    privateMiners[i].summary.data["Stratum"] = null;
                }
                privateMiners[i].ip = null;
            }

            fs.writeFile(arg.filePaths[0] + '/epicminers.log', JSON.stringify(privateMiners), function (err) {
                if (err) throw err;
                console.log('done');
            })
            mainWindow.webContents.send('toast', {
                type: 'good',
                message: 'Successfully dumped data!'
            })
        }
    }).catch(err=>{
        mainWindow.webContents.send('toast', {
            type: 'bad',
            message: 'Something went wrong while dumping data'
        })
        console.log(err);
    })
});

ipcMain.on('open-link', (e, arg) => {
    (async () => {
        await open(arg);
    })();
})
